// Spoken formatting commands: paragraph/line breaks and named punctuation become their literal
// characters. Deterministic and instant: applied after dictionary correction and before AI cleanup,
// so core English dictation commands still work when cleanup is unavailable.

const PARAGRAPH_PHRASES =
  String.raw`(?:start|begin|make)\s+(?:a\s+)?new\s+paragraph|` +
  String.raw`(?:new|next)\s+paragraph|paragraph\s+break|blank\s+line|leave\s+(?:a\s+)?(?:space|gap)`
const LINE_PHRASES = String.raw`(?:new|next)\s+line|line\s+break`
const PUNCTUATION_PHRASES =
  String.raw`full\s+stop|period|comma|question\s+mark|` +
  String.raw`exclamation\s+(?:mark|point)|colon|semi[ -]?colon|ellipsis|dot\s+dot\s+dot|` +
  String.raw`hyphen|(?:open|left)\s+parenthes(?:is|es)|(?:close|right)\s+parenthes(?:is|es)|` +
  String.raw`(?:open|begin|start)\s+quote|(?:close|end)\s+quote`

// Optional leading article ("a new paragraph about X") marks the phrase as content, not a command.
const BREAK_COMMAND = new RegExp(
  String.raw`(\b(?:a|the|one)\s+)?\b(${PARAGRAPH_PHRASES}|${LINE_PHRASES})\b[.,!?;:]*\s*`,
  'gi'
)
const PUNCTUATION_COMMAND = new RegExp(
  String.raw`(\b(?:a|the|one)\s+)?\b(${PUNCTUATION_PHRASES})\b[.,!?;:]*[ \t]*`,
  'gi'
)

const MARK = {
  comma: '\uE000',
  period: '\uE001',
  question: '\uE002',
  exclamation: '\uE003',
  colon: '\uE004',
  semicolon: '\uE005',
  ellipsis: '\uE006',
  hyphen: '\uE007',
  openParen: '\uE008',
  closeParen: '\uE009',
  openQuote: '\uE00A',
  closeQuote: '\uE00B'
} as const

/**
 * Replace spoken formatting commands with real breaks and punctuation. Whisper's punctuation
 * around the command is absorbed, the next word is capitalized, and clearly literal uses remain
 * ordinary prose. Total: never throws, and no-command text passes through untouched.
 */
export function applyVoiceCommands(text: string): string {
  if (!text) return text

  let replaced = text.replace(
    BREAK_COMMAND,
    (match, article: string | undefined, phrase: string) => {
      if (article) return match
      return /line/i.test(phrase) && !/blank/i.test(phrase) ? '\n' : '\n\n'
    }
  )

  replaced = replaced.replace(
    PUNCTUATION_COMMAND,
    (match, article: string | undefined, phrase: string, offset: number, source: string) => {
      if (article || isClearlyLiteralPunctuation(offset, match, source)) return match
      return punctuationMark(phrase)
    }
  )

  return replaced
    .replace(new RegExp(`[ \\t]*${MARK.comma}[ \\t]*`, 'g'), ', ')
    .replace(new RegExp(`[ \\t]*${MARK.period}[ \\t]*`, 'g'), '. ')
    .replace(new RegExp(`[ \\t]*${MARK.question}[ \\t]*`, 'g'), '? ')
    .replace(new RegExp(`[ \\t]*${MARK.exclamation}[ \\t]*`, 'g'), '! ')
    .replace(new RegExp(`[ \\t]*${MARK.colon}[ \\t]*`, 'g'), ': ')
    .replace(new RegExp(`[ \\t]*${MARK.semicolon}[ \\t]*`, 'g'), '; ')
    .replace(new RegExp(`[ \\t]*${MARK.ellipsis}[ \\t]*`, 'g'), '… ')
    .replace(new RegExp(`[ \\t]*${MARK.hyphen}[ \\t]*`, 'g'), ' - ')
    .replace(new RegExp(`[ \\t]*${MARK.openParen}[ \\t]*`, 'g'), ' (')
    .replace(new RegExp(`[ \\t]*${MARK.closeParen}`, 'g'), ')')
    .replace(new RegExp(`[ \\t]*${MARK.openQuote}[ \\t]*`, 'g'), ' "')
    .replace(new RegExp(`[ \\t]*${MARK.closeQuote}`, 'g'), '"')
    .replace(/([,;:])\1+/g, '$1')
    .replace(/([.!?…])[.!?…]+/g, '$1')
    .replace(/[,;:]+([.!?…])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/([.!?…]) ([a-z])/g, (_m, punctuation: string, ch: string) => punctuation + ' ' + ch.toUpperCase())
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n([a-z])/g, (_m, ch: string) => '\n' + ch.toUpperCase())
    .replace(/[ \t]+$/gm, '')
    .replace(/^[ \t]+/, '')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '')
}

function punctuationMark(phrase: string): string {
  const normalized = phrase.toLowerCase().replace(/[ -]+/g, ' ')
  if (normalized === 'comma') return MARK.comma
  if (normalized === 'full stop' || normalized === 'period') return MARK.period
  if (normalized === 'question mark') return MARK.question
  if (normalized.startsWith('exclamation ')) return MARK.exclamation
  if (normalized === 'colon') return MARK.colon
  if (normalized === 'semicolon' || normalized === 'semi colon') return MARK.semicolon
  if (normalized === 'ellipsis' || normalized === 'dot dot dot') return MARK.ellipsis
  if (normalized === 'hyphen') return MARK.hyphen
  if (/^(?:open|left) parenthes/.test(normalized)) return MARK.openParen
  if (/^(?:close|right) parenthes/.test(normalized)) return MARK.closeParen
  if (/^(?:open|begin|start) quote$/.test(normalized)) return MARK.openQuote
  return MARK.closeQuote
}

function isClearlyLiteralPunctuation(offset: number, match: string, source: string): boolean {
  const before = source.slice(0, offset)
  const remainder = source.slice(offset + match.length)
  if (
    /^-?(?:separated|delimited|operator|character|key|symbol|means|is|was|ended|began|ends|lasts|of|for|between|cancer)\b/i.test(
      remainder
    )
  ) {
    return true
  }
  if (
    /\b(?:word|term|character|symbol|key|literal|oxford|trial|billing|grace|menstrual|historical|time)\s+$/i.test(
      before
    )
  ) {
    return true
  }
  return offset === 0 && /^(?:means|is|was|ended|began)\b/i.test(remainder)
}
