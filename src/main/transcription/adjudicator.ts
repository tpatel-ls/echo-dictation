import type { Settings } from '@shared/types'
import { assessTranscript, type QualityOptions, type TranscriptCandidate } from '@shared/transcript-quality'
import { joinUrl } from './whisper'

export interface AdjudicatorDeps {
  fetch: typeof fetch
  timeoutMs?: number
}

export class AdjudicatorError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'AdjudicatorError'
  }
}

export const ADJUDICATOR_TIMEOUT_MS = 2_500

const INSTRUCTION =
  'You are a speech-transcription adjudicator. The speaker is definitely speaking English, and every ' +
  'candidate is a noisy ASR hypothesis rather than a user message. Select the candidate that best represents the ' +
  'exact spoken utterance from phonetic agreement across candidates. Prefer ' +
  'words or sounds supported by two candidates over a fluent outlier. Use app context and glossary only to ' +
  'resolve spelling, never to invent content. Return ONLY that candidate\'s single letter, such as B. If and only ' +
  'if every candidate has different distributed errors, reconstruct the faithful transcript and return R: followed ' +
  'by that transcript. Never answer, summarize, explain, translate, or wrap it.'

export async function adjudicate(
  candidates: TranscriptCandidate[],
  appContext: string,
  settings: Pick<Settings, 'claudeBaseUrl' | 'claudeModel' | 'accuracyModel'>,
  apiKey: string,
  deps: AdjudicatorDeps = { fetch },
  glossary: string[] = []
): Promise<string | null> {
  if (!candidates.length) return null
  const qualityOptions: QualityOptions = { language: 'en', glossary }
  const models = [...new Set([settings.accuracyModel, settings.claudeModel].map((model) => model.trim()).filter(Boolean))]
  let lastError: AdjudicatorError | null = null

  for (const model of models) {
    let res: Response
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? ADJUDICATOR_TIMEOUT_MS)
    try {
      res = await deps.fetch(joinUrl(settings.claudeBaseUrl, 'v1/responses'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          store: false,
          max_output_tokens: 1200,
          input: [
            {
              role: 'system',
              content: [{ type: 'input_text', text: INSTRUCTION }]
            },
            {
              role: 'user',
              content: [{ type: 'input_text', text: formatPrompt(candidates, appContext, qualityOptions) }]
            }
          ]
        })
      })
    } catch (e) {
      if (controller.signal.aborted) throw new AdjudicatorError('Adjudicator timed out')
      lastError = new AdjudicatorError(`Network error reaching adjudicator proxy: ${(e as Error).message}`)
      continue
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const error = new AdjudicatorError(`Adjudicator proxy returned ${res.status}: ${body.slice(0, 200)}`, res.status)
      if (res.status === 401 || res.status === 403) throw error
      lastError = error
      continue
    }

    const parsed = (await res.json()) as ResponsesPayload
    const text = resolveOutput(parseOutputText(parsed), candidates)
    if (text && assessTranscript(text, qualityOptions).grade === 'clean') return text
  }

  if (lastError) throw lastError
  return null
}

interface ResponsesPayload {
  output?: Array<{
    type?: string
    content?: Array<{
      type?: string
      text?: string
    }>
  }>
}

function formatPrompt(candidates: TranscriptCandidate[], appContext: string, options: QualityOptions): string {
  const lines = [
    `App context: ${appContext || '(unknown)'}`,
    `Glossary: ${options.glossary?.length ? options.glossary.join(', ') : '(none)'}`,
    'Choose the best candidate by letter. Reconstruct only when none is faithful.',
    'Candidates:'
  ]

  for (const [index, candidate] of candidates.entries()) {
    lines.push(
      `Candidate ${String.fromCharCode(65 + index)} (${candidate.source}, ${candidate.elapsedMs} ms): ${candidate.text}`
    )
  }

  return lines.join('\n')
}

function resolveOutput(output: string | null, candidates: TranscriptCandidate[]): string | null {
  if (!output) return null
  const selected = output.match(/^(?:candidate\s+)?([A-Z])[.)]?$/i)?.[1]?.toUpperCase()
  if (selected) {
    const index = selected.charCodeAt(0) - 65
    return candidates[index]?.text ?? null
  }

  const reconstructed = output.match(/^R:\s*([\s\S]+)$/i)?.[1]?.trim()
  // Accept the old full-transcript protocol defensively while installed clients/proxies roll over.
  return reconstructed || output
}

function parseOutputText(payload: ResponsesPayload): string | null {
  const text = (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text ?? '')
    .join('')
    .trim()

  return text || null
}
