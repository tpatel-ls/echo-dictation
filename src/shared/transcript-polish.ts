const AUTO_PARAGRAPH_MIN_WORDS = 90
const STRONG_TRANSITION_MIN_WORDS = 25
const CONTRAST_TRANSITION_MIN_WORDS = 55
const MAX_PARAGRAPH_WORDS = 110
const MIN_TRAILING_PARAGRAPH_WORDS = 12

const POSSESSIVE_REPAIRS: Array<[RegExp, string]> = [
  [/\banthropics\b/giu, "Anthropic's"],
  [/\bcodexs\b/giu, "Codex's"],
  [/\bopen\s+ais\b/giu, "OpenAI's"],
  [/\bopenais\b/giu, "OpenAI's"],
  [/\bclaudes\b/giu, "Claude's"],
  [/\bgithubs\b/giu, "GitHub's"],
  [/\bmicrosofts\b/giu, "Microsoft's"],
  [/\bgoogles\b/giu, "Google's"]
]

const TECHNICAL_CASING_REPAIRS: Array<[RegExp, string]> = [
  [/\bopen\s*ai\b/giu, 'OpenAI'],
  [/\bchat\s*gpt\b/giu, 'ChatGPT'],
  [/\bgithub\b/giu, 'GitHub'],
  [/\bcodex\b/giu, 'Codex'],
  [/\banthropic\b/giu, 'Anthropic'],
  [/\bgb\s*10\b/giu, 'GB10']
]

const STRONG_TRANSITION =
  /^(?:this (?:comes|means|brings|leads)|meanwhile\b|on the other hand\b|as for\b|regarding\b|the (?:issue|problem|next|result|reason)\b)/iu
const CONTRAST_TRANSITION = /^(?:so\b|however\b|but\b|therefore\b|instead\b|finally\b|overall\b)/iu

/**
 * Zero-network polish for mistakes ASR commonly makes even when the words are otherwise correct.
 * It intentionally never paraphrases: only known possessive spellings and whitespace paragraph
 * boundaries can change.
 */
export function polishTranscriptStructure(text: string): string {
  const repaired = repairKnownPossessives(text)
  if (countWords(repaired) < AUTO_PARAGRAPH_MIN_WORDS || repaired.includes('\n')) return repaired

  const sentences = splitSentences(repaired)
  if (sentences.length < 4) return repaired

  const paragraphs: string[][] = []
  let current: string[] = []
  let currentWords = 0

  for (const sentence of sentences) {
    const sentenceWords = countWords(sentence)
    const startsStrongTransition = STRONG_TRANSITION.test(sentence)
    const startsContrastTransition = CONTRAST_TRANSITION.test(sentence)
    const shouldBreak =
      current.length > 0 &&
      ((startsStrongTransition && currentWords >= STRONG_TRANSITION_MIN_WORDS) ||
        (startsContrastTransition && currentWords >= CONTRAST_TRANSITION_MIN_WORDS) ||
        currentWords + sentenceWords > MAX_PARAGRAPH_WORDS)

    if (shouldBreak) {
      paragraphs.push(current)
      current = []
      currentWords = 0
    }
    current.push(sentence)
    currentWords += sentenceWords
  }
  if (current.length) paragraphs.push(current)

  if (paragraphs.length < 2) return repaired
  const trailing = paragraphs.at(-1) ?? []
  if (countWords(trailing.join(' ')) < MIN_TRAILING_PARAGRAPH_WORDS && paragraphs.length > 1) {
    paragraphs[paragraphs.length - 2]?.push(...trailing)
    paragraphs.pop()
  }

  return paragraphs.map((paragraph) => paragraph.join(' ')).join('\n\n')
}

function repairKnownPossessives(text: string): string {
  let repaired = text
  for (const [pattern, canonical] of POSSESSIVE_REPAIRS) {
    repaired = repaired.replace(pattern, (match) => applyCase(match, canonical))
  }
  for (const [pattern, canonical] of TECHNICAL_CASING_REPAIRS) {
    repaired = repaired.replace(pattern, canonical)
  }
  return repaired
}

function applyCase(match: string, canonical: string): string {
  if (match === match.toLowerCase()) return canonical.toLowerCase()
  if (match === match.toUpperCase()) return canonical.toUpperCase()
  return canonical
}

function splitSentences(text: string): string[] {
  return (
    text
      .replace(/\s+/g, ' ')
      .trim()
      .match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) ?? []
  )
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}']+/gu)?.length ?? 0
}
