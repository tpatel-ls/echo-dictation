// Deterministic written forms for things speech recognizers leave as spoken: acronyms read letter by
// letter ("P R s" → "PRs") and cardinal number words ("twenty seven" → "27"). Zero network, so the
// pasted text is right even when AI cleanup is skipped, slow, or unavailable.

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9
}
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19
}
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
}
const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9 }

const NUMBER_WORD = `(?:${[...Object.keys(UNITS), ...Object.keys(TEENS), ...Object.keys(TENS), 'hundred', ...Object.keys(SCALES)].join('|')})`
const DIGIT_WORD = `(?:${Object.keys(UNITS).join('|')})`
const NUMBER_RUN = new RegExp(
  `(?<![\\p{L}\\p{N}'-])(a\\s+)?(${NUMBER_WORD}(?:(?:\\s+|-)(?:and\\s+)?${NUMBER_WORD})*)` +
    `(?:\\s+point((?:\\s+${DIGIT_WORD})+))?(\\s+percent)?(?![\\p{L}\\p{N}'-])`,
  'giu'
)
const SPELLED_ACRONYM = /(?<![\p{L}\p{N}'])([A-Z](?:\s[A-Z])+)(?:\s?('?s))?(?![\p{L}\p{N}'])/gu

export function normalizeSpokenForms(text: string): string {
  return convertNumberWords(joinSpelledAcronyms(text))
}

function joinSpelledAcronyms(text: string): string {
  return text.replace(SPELLED_ACRONYM, (match, spelled: string, suffix: string | undefined) => {
    const letters = spelled.replace(/\s/g, '')
    // "Plan A I think" — two letters including the words A or I are far more likely real words.
    if (letters.length === 2 && /[AI]/.test(letters)) return match
    return letters + (suffix ?? '')
  })
}

function convertNumberWords(text: string): string {
  return text.replace(
    NUMBER_RUN,
    (match, article: string | undefined, run: string, decimals: string | undefined, percent: string | undefined) => {
      const words = run.toLowerCase().split(/[\s-]+/).filter((word) => word !== 'and')
      // "no one", "one of them": a bare "one" is almost always a pronoun, not a quantity.
      if (words.length === 1 && words[0] === 'one' && !decimals && !percent) return match
      const startsWithScale = words[0] === 'hundred' || words[0]! in SCALES
      if (article && !startsWithScale) return match
      const numbers = parseRun(words)
      if (!numbers) return match

      let written: string
      if (numbers.length === 2 && !decimals && numbers.every((n) => n >= 10 && n <= 99)) {
        written = `${numbers[0]}${String(numbers[1]).padStart(2, '0')}` // "twenty twenty six" → 2026
      } else {
        written = numbers.map(formatInteger).join(' ')
      }
      if (decimals) {
        if (numbers.length !== 1) return match
        written += '.' + decimals.trim().toLowerCase().split(/\s+/).map((word) => UNITS[word]).join('')
      }
      return written + (percent ? '%' : '')
    }
  )
}

/** Parse number words into one or more integers ("twenty twenty six" → [20, 26]), or null. */
function parseRun(words: string[]): number[] | null {
  const numbers: number[] = []
  let total = 0
  let current = 0
  let last: 'none' | 'unit' | 'teen' | 'tens' | 'hundred' | 'scale' = 'none'
  const flush = (): void => {
    numbers.push(total + current)
    total = 0
    current = 0
  }

  for (const word of words) {
    if (word in UNITS) {
      if (last === 'unit' || last === 'teen') flush()
      current += UNITS[word]!
      last = 'unit'
    } else if (word in TEENS) {
      if (last === 'unit' || last === 'teen' || last === 'tens') flush()
      current += TEENS[word]!
      last = 'teen'
    } else if (word in TENS) {
      if (last === 'unit' || last === 'teen' || last === 'tens') flush()
      current += TENS[word]!
      last = 'tens'
    } else if (word === 'hundred') {
      if (last === 'hundred') return null
      current = (current || 1) * 100
      last = 'hundred'
    } else if (word in SCALES) {
      if (last === 'scale') return null
      total += (current || 1) * SCALES[word]!
      current = 0
      last = 'scale'
    } else {
      return null
    }
  }
  flush()
  return numbers
}

function formatInteger(value: number): string {
  return value >= 10_000 ? value.toLocaleString('en-US') : String(value)
}
