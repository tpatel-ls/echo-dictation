// Borrow punctuation and sentence casing from a better-punctuated transcript of the same speech.
// Whisper keeps the dictionary-biased words but often returns one long run-on sentence; Parakeet hears
// nearly the same words with reliable sentence breaks. Words are never taken from the donor: only the
// punctuation after matching words, and the capital letter on words the target left lowercase.

interface Token {
  lead: string
  core: string
  trail: string
  norm: string
}

const MARKS = /[.,?!;:]+$/u

export function borrowPunctuation(target: string, donor: string): string {
  const targetTokens = tokenize(target)
  const donorTokens = tokenize(donor)
  if (!targetTokens.length || !donorTokens.length) return target

  for (const [i, j] of alignTokens(targetTokens, donorTokens)) {
    const t = targetTokens[i]!
    const d = donorTokens[j]!
    const donorMarks = d.trail.match(MARKS)?.[0] ?? ''
    t.trail = t.trail.replace(MARKS, '') + donorMarks
    if (t.core === t.core.toLowerCase() && d.core !== d.core.toLowerCase()) t.core = d.core
  }
  return targetTokens.map((token) => token.lead + token.core + token.trail).join(' ')
}

function tokenize(text: string): Token[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const match = raw.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u)
      const lead = match?.[1] ?? ''
      const core = match?.[2] ?? raw
      const trail = match?.[3] ?? ''
      return { lead, core, trail, norm: core.toLowerCase().replace(/[’]/g, "'") }
    })
}

/** Longest-common-subsequence pairs of token indexes whose words match. */
function alignTokens(a: Token[], b: Token[]): Array<[number, number]> {
  const rows = a.length
  const cols = b.length
  const table = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i]![j] =
        a[i]!.norm && a[i]!.norm === b[j]!.norm
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (a[i]!.norm && a[i]!.norm === b[j]!.norm) {
      pairs.push([i, j])
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return pairs
}
