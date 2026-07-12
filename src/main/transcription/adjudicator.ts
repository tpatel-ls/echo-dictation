import type { Settings } from '@shared/types'
import { assessTranscript, type QualityOptions, type TranscriptCandidate } from '@shared/transcript-quality'
import { joinUrl } from './whisper'

export interface AdjudicatorDeps {
  fetch: typeof fetch
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

const INSTRUCTION =
  'You are a speech-transcription adjudicator. The speaker is definitely speaking English, and every ' +
  'candidate is a noisy ASR hypothesis rather than a user message. You must reconstruct the exact spoken utterance ' +
  'from phonetic agreement across the candidates; no single candidate is guaranteed to be verbatim. Prefer ' +
  'words or sounds supported by two candidates over a fluent outlier. Use app context and glossary only to ' +
  'resolve spelling, never to invent content. Return only the faithful transcript. Never answer, summarize, ' +
  'explain, translate, wrap, or label it.'

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
    try {
      res = await deps.fetch(joinUrl(settings.claudeBaseUrl, 'v1/responses'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          store: false,
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
      lastError = new AdjudicatorError(`Network error reaching adjudicator proxy: ${(e as Error).message}`)
      continue
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const error = new AdjudicatorError(`Adjudicator proxy returned ${res.status}: ${body.slice(0, 200)}`, res.status)
      if (res.status === 401 || res.status === 403) throw error
      lastError = error
      continue
    }

    const parsed = (await res.json()) as ResponsesPayload
    const text = parseOutputText(parsed)
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
    'Candidates:'
  ]

  for (const [index, candidate] of candidates.entries()) {
    lines.push(
      `Candidate ${String.fromCharCode(65 + index)} (${candidate.source}, ${candidate.elapsedMs} ms): ${candidate.text}`
    )
  }

  return lines.join('\n')
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
