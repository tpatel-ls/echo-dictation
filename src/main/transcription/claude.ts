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

const COMMAND_SYSTEM_PROMPT =
  'You are a precise in-place text editor. Apply the user’s instruction to the provided text and ' +
  'return ONLY the resulting text — no preamble, quotes, or explanation. Preserve the original ' +
  'meaning and formatting unless the instruction asks otherwise.'

/** Pin the user's dictionary onto a system prompt so neither cleanup nor a command un-corrects it. */
function withGlossary(base: string, glossary: string[]): string {
  return glossary.length
    ? `${base} The speaker's custom vocabulary — always keep these exact spellings: ${glossary.join(', ')}.`
    : base
}

/** One Anthropic /v1/messages round-trip: `system` + a single user message, parsed to text with
 *  `fallback` returned on an empty response. Throws CleanupError on network/HTTP failure. */
async function post(
  system: string,
  userContent: string,
  fallback: string,
  settings: Pick<Settings, 'claudeBaseUrl' | 'claudeModel'>,
  apiKey: string,
  deps: ClaudeDeps
): Promise<string> {
  const url = joinUrl(settings.claudeBaseUrl, 'v1/messages')
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
        messages: [{ role: 'user', content: userContent }]
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
  return out || fallback
}

/**
 * Send raw transcript text to the Anthropic-compatible proxy for cleanup. Throws CleanupError on
 * failure; callers decide whether to fall back to raw text. `glossary` lists the user's dictionary
 * words so cleanup never "fixes" them back; `styleDirective` adapts the tone to the focused app.
 */
export async function cleanup(
  text: string,
  settings: Pick<Settings, 'claudeBaseUrl' | 'claudeModel'>,
  apiKey: string,
  deps: ClaudeDeps = { fetch },
  glossary: string[] = [],
  styleDirective?: string | null
): Promise<string> {
  let system = withGlossary(SYSTEM_PROMPT, glossary)
  if (styleDirective) system = `${system} ${styleDirective}`
  return post(system, text, text, settings, apiKey, deps)
}

/**
 * Command Mode: apply a spoken `instruction` to `text` (the user's selection) and return the rewrite,
 * or the original `text` on an empty response. `glossary` is pinned so custom spellings survive.
 */
export async function command(
  text: string,
  instruction: string,
  settings: Pick<Settings, 'claudeBaseUrl' | 'claudeModel'>,
  apiKey: string,
  deps: ClaudeDeps = { fetch },
  glossary: string[] = []
): Promise<string> {
  const system = withGlossary(COMMAND_SYSTEM_PROMPT, glossary)
  return post(system, `Instruction: ${instruction}\n\nText:\n${text}`, text, settings, apiKey, deps)
}
