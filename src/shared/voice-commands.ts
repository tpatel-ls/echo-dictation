// Spoken formatting commands: "new paragraph" / "leave space" → blank line, "new line" → line
// break. Deterministic and instant — applied right after dictionary correction, before any AI
// cleanup, so commands work even when the cleanup endpoint is down. Pure + unit-tested; mirrors
// the Android VoiceCommands.kt.

const PARAGRAPH_PHRASES = String.raw`(?:new|next)\s+paragraph|paragraph\s+break|leave\s+(?:a\s+)?(?:space|gap)`
const LINE_PHRASES = String.raw`(?:new|next)\s+line|line\s+break`

// Optional leading article ("a new paragraph about X") marks the phrase as content, not a command.
const COMMAND = new RegExp(
  String.raw`(\b(?:a|the|one)\s+)?\b(${PARAGRAPH_PHRASES}|${LINE_PHRASES})\b[.,!?;:]*\s*`,
  'gi'
)

/**
 * Replace spoken formatting commands in a transcript with real breaks: paragraph commands become
 * a blank line, line commands a single newline. Whisper's own punctuation around the command is
 * absorbed, the first word after a break is capitalized, and phrases preceded by an article
 * ("add a new paragraph about…") are left literal. Total — never throws, no-command text passes
 * through untouched.
 */
export function applyVoiceCommands(text: string): string {
  if (!text) return text

  const replaced = text.replace(COMMAND, (match, article: string | undefined, phrase: string) => {
    if (article) return match
    return /line/i.test(phrase) ? '\n' : '\n\n'
  })

  return replaced
    .replace(/[ \t]+\n/g, '\n') // space left before an inserted break
    .replace(/\n{3,}/g, '\n\n') // consecutive commands collapse to one blank line
    .replace(/\n([a-z])/g, (_m, ch: string) => '\n' + ch.toUpperCase())
    .replace(/^\n+/, '')
    .replace(/\s+$/, '')
}
