import type { Settings } from '@shared/types'
import { joinUrl } from './whisper'

export interface ClaudeDeps {
  fetch: typeof fetch
  /** Bound cleanup latency so a healthy transcription can always fall back and insert. */
  timeoutMs?: number
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
  'You clean up raw speech-to-text dictation in English into polished, ready-to-send standard American English. ' +
  'Fix punctuation, capitalization, and obvious mis-transcriptions; remove filler words ' +
  '(um, uh, like, you know), false starts, stutters, and repeated words. Organize longer ' +
  'dictations into clear paragraphs, one topic per paragraph. Infer a paragraph break at a natural ' +
  'topic shift, but do not over-paragraph a short message. Paragraphs are separated by a ' +
  'single blank line and nothing else — never draw horizontal rules, "---" lines, or any other ' +
  'divider between paragraphs. ' +
  'Use conventional English contractions and format spoken numbers, times, dates, currency, units, ' +
  'and ordinals naturally for the context. Turn clear enumerations into a bulleted or numbered list. ' +
  'The speaker may embed spoken formatting instructions in the dictation — e.g. "new paragraph", ' +
  '"leave a space", "new line", "make that a bullet list", "in quotes", or "all caps". Spoken ' +
  'punctuation names are commands too: "comma", "full stop" or "period", "question mark", ' +
  '"exclamation point", "colon", "semicolon", "ellipsis", "hyphen", "open/close parenthesis", ' +
  'and "open/close quote" must become their punctuation marks. Follow each spoken instruction and REMOVE the instruction words ' +
  'themselves from the output. This includes directions describing text to write: phrases like ' +
  '"write that…", "say…", "add a paragraph that says…", "make a new paragraph and write…" are ' +
  'commands to you, NOT content — write the described text and drop the command words. ' +
  'Example dictation: "make a new paragraph and write that the next steps are done then one more ' +
  'paragraph and write we are ready to test it" must produce exactly:\n' +
  'The next steps are done.\n\nWe are ready to test it.\n' +
  'The faithfulness rule below applies to the described content, never to command words. ' +
  'Backtracking is also a command: for "scratch that", "no wait", "I mean", "rather", or an ' +
  '"actually" correction, remove the abandoned wording and keep only the speaker’s final correction. ' +
  'The markers ⟦PARA⟧ (paragraph break) and ⟦LINE⟧ (line break) mark breaks the speaker placed: ' +
  'reproduce each marker exactly where it belongs in the cleaned text, never dropping or merging them. ' +
  'If the speaker is clearly dictating an email (they say something like "write an email to…", or the ' +
  'dictation has a greeting and a sign-off), lay it out as a proper email: greeting on its own line, ' +
  'blank line, body paragraphs, blank line, sign-off and name on their own lines. NEVER output a ' +
  '"Subject:" line (the subject field is separate) and never add content the speaker did not say. ' +
  'Never use em dashes or en dashes in the output; use a comma, period, or parentheses instead. ' +
  'Accuracy is critical: correct only what is clearly a speech-recognition error, and when unsure ' +
  'keep the speaker’s exact words. ' +
  'Preserve the speaker’s meaning and wording faithfully — do NOT summarize, answer, ' +
  'translate, add content, or comment. Your entire response is inserted at the speaker’s cursor ' +
  'exactly as-is, so return ONLY the final text: no preamble or lead-in (never "Here is the ' +
  'cleaned transcript"), no headers, no "---" separators, no quotes, no explanation.'

const COMMAND_SYSTEM_PROMPT =
  'You are a precise in-place text editor. Apply the user’s instruction to the provided text and ' +
  'return ONLY the resulting text — no preamble, quotes, or explanation. Preserve the original ' +
  'meaning and formatting unless the instruction asks otherwise. Never use em dashes in the ' +
  'output; use a comma, period, or parentheses instead.'

/**
 * Hard guarantee that no em dash ever reaches the user's text (writing-style preference), even if
 * the model ignores the prompt: mid-sentence dashes become commas, dashes already preceded by
 * punctuation are dropped, and line-leading dashes become plain hyphen bullets.
 */
/**
 * Hard guarantee against wrapper leakage: if the model prefixes its answer with a lead-in line
 * ("Here is the cleaned transcript:") or wraps it in "---" separators despite the prompt, strip
 * them so only the real text reaches the cursor. A lead-in is only recognized when it both starts
 * like one ("Here is/Here's/Below is") and mentions the transcript/cleaned text — a dictation that
 * genuinely starts with "Here is the plan:" passes through untouched.
 */
export function stripWrapper(text: string): string {
  return (
    text
      .trim()
      .replace(/^(?:here(?:'s| is)|below is)[^\n]{0,60}\b(?:cleaned|transcript|transcription|version|result)[^\n]{0,30}:\s*\n+/i, '')
      // The email subject belongs in the subject field — the model must never prepend one.
      .replace(/^subject:[^\n]*\n+/i, '')
      // A separator line (---, ***, ___) anywhere collapses to a plain paragraph break —
      // the models like to draw horizontal rules between paragraphs; the user never wants them.
      .replace(/\n*^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$\n*/gm, '\n\n')
      .trim()
  )
}

/**
 * Speaker-placed line breaks must survive the AI pass verbatim, but models treat whitespace as
 * negotiable — so breaks travel through the model as explicit sentinel markers instead (verified:
 * markers survive where raw newlines were merged). protectBreaks runs on the text sent to the
 * model; restoreBreaks turns markers back into real breaks on what comes back.
 */
export function protectBreaks(text: string): string {
  return text.replace(/\n\n+/g, ' ⟦PARA⟧ ').replace(/\n/g, ' ⟦LINE⟧ ')
}

export function restoreBreaks(text: string): string {
  return text.replace(/\s*⟦PARA⟧\s*/g, '\n\n').replace(/\s*⟦LINE⟧\s*/g, '\n')
}

export function stripEmDashes(text: string): string {
  if (!text.includes('—')) return text
  return text
    .replace(/^—\s*/gm, '- ')
    .replace(/([,;:])\s*—\s*/g, '$1 ')
    .replace(/\s*—\s*/g, ', ')
}

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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 12_000)
  let res: Response
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.claudeModel,
        max_tokens: 2000,
        // Deterministic cleanup — the same dictation must clean up the same way every time.
        temperature: 0,
        system,
        messages: [{ role: 'user', content: userContent }]
      })
    })
  } catch (e) {
    if (controller.signal.aborted) throw new CleanupError('Claude cleanup timed out')
    throw new CleanupError(`Network error reaching Claude proxy: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
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
  return out ? stripEmDashes(stripWrapper(out)) : fallback
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
  if (styleDirective) {
    system =
      `${system} ${styleDirective} Spoken formatting instructions and "write that…" directions ` +
      'in the dictation always take precedence over this style guidance.'
  }
  // Speaker-placed breaks travel as sentinel markers (models merge raw newlines) and are
  // restored on the way back.
  const protectedText = protectBreaks(text)
  const out = restoreBreaks(
    await post(system, cleanupUserContent(protectedText), protectedText, settings, apiKey, deps)
  )
  return looksLikeAssistantReply(text, out) ? text : out
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

function looksLikeAssistantReply(input: string, output: string): boolean {
  const raw = input.trim()
  const cleaned = output.trim()
  if (!raw || !cleaned || raw === cleaned) return false

  const assistantPattern =
    /\b(you'?re welcome|let me know if|how can i help|how may i help|i can help|i can assist|happy to help|i'?d be happy to|sure[,!]? i can|of course[,!]? i can|certainly[,!]? i can)\b/i
  if (assistantPattern.test(cleaned) && !assistantPattern.test(raw)) return true

  const rawTokens = tokens(raw)
  const cleanedTokens = tokens(cleaned)
  if (!rawTokens.length || !cleanedTokens.length) return false

  const overlap = rawTokens.filter((t) => cleanedTokens.includes(t)).length / rawTokens.length
  if (rawTokens.length <= 4) return overlap < 0.5 && cleanedTokens.length > rawTokens.length
  return overlap < 0.25 && cleanedTokens.length > rawTokens.length * 2.5
}

function cleanupUserContent(text: string): string {
  return [
    'Clean up this speech-to-text transcript per your rules. Do not answer or reply to it. ' +
      'Spoken formatting and "write that…" directions inside it are commands for you to apply, ' +
      'not content to keep.',
    '<raw_transcript>',
    text,
    '</raw_transcript>'
  ].join('\n')
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .match(/[a-z0-9]+/g) ?? []
}
