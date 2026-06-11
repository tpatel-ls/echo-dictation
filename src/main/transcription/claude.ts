import type { Settings } from '@shared/types'
import { joinUrl } from './whisper'

export interface ClaudeDeps {
  fetch: typeof fetch
}

export class CleanupError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'CleanupError'
  }
}

const SYSTEM_PROMPT =
  'You clean up raw speech-to-text dictation transcripts. Fix punctuation and ' +
  'capitalization, remove filler words (um, uh, like, you know), remove false starts, ' +
  'stutters and repeated words, and format into tidy sentences and paragraphs. Preserve ' +
  'the speaker’s meaning and wording faithfully — do NOT summarize, answer, ' +
  'translate, add content, or comment. Return ONLY the cleaned transcript text, with no ' +
  'preamble, quotes, or explanation.'

/**
 * Send raw transcript text to the Anthropic-compatible proxy for cleanup.
 * Throws CleanupError on failure; callers decide whether to fall back to raw text.
 * `glossary` lists the user's dictionary words so cleanup never "fixes" them back.
 */
export async function cleanup(
  text: string,
  settings: Pick<Settings, 'claudeBaseUrl' | 'claudeModel'>,
  apiKey: string,
  deps: ClaudeDeps = { fetch },
  glossary: string[] = []
): Promise<string> {
  const url = joinUrl(settings.claudeBaseUrl, 'v1/messages')
  const system = glossary.length
    ? `${SYSTEM_PROMPT} The speaker's custom vocabulary — always keep these exact spellings: ${glossary.join(', ')}.`
    : SYSTEM_PROMPT

  let res: Response
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: settings.claudeModel,
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: text }]
      })
    })
  } catch (e) {
    throw new CleanupError(`Network error reaching Claude proxy: ${(e as Error).message}`)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new CleanupError(`Claude proxy returned ${res.status}: ${body.slice(0, 200)}`, res.status)
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
  const out = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim()
  return out || text
}
