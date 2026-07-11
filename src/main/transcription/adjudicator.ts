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
  'You are adjudicating competing speech-to-text candidates. The speaker is definitely speaking English. ' +
  'Return only the most faithful transcript text from the candidates. Never answer, summarize, explain, ' +
  'translate, wrap, label, or clean it up beyond choosing the best candidate text.'

export async function adjudicate(
  candidates: TranscriptCandidate[],
  appContext: string,
  settings: Pick<Settings, 'claudeBaseUrl' | 'accuracyModel'>,
  apiKey: string,
  deps: AdjudicatorDeps = { fetch },
  glossary: string[] = []
): Promise<string | null> {
  if (!candidates.length) return null
  const qualityOptions: QualityOptions = { language: 'en', glossary }

  const res = await deps.fetch(joinUrl(settings.claudeBaseUrl, 'v1/responses'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: settings.accuracyModel,
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
  }).catch((e) => {
    throw new AdjudicatorError(`Network error reaching adjudicator proxy: ${(e as Error).message}`)
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new AdjudicatorError(`Adjudicator proxy returned ${res.status}: ${body.slice(0, 200)}`, res.status)
  }

  const parsed = (await res.json()) as ResponsesPayload
  const text = parseOutputText(parsed)
  if (!text) return null

  return assessTranscript(text, qualityOptions).grade === 'clean' ? text : null
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
