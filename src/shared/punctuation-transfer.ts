// Borrow punctuation and sentence casing from a better-punctuated transcript of the same speech.
// Whisper keeps the dictionary-biased words but often returns one long run-on sentence; Parakeet hears
// nearly the same words with reliable sentence breaks. Words are never taken from the donor: only the
// punctuation after matching words, and the capital letter on words the target left lowercase.

export interface Token {
  lead: string
  core: string
  trail: string
  norm: string
}

const MARKS = /[.,?!;:]+$/u

/**
 * `substitutions`: also pair words between two matches when both sides have the same number of
 * them ("BROXA" where the donor heard "brocksa."), taking the donor's marks and a leading capital but
 * never its spelling. The target's own words are the ones a keyword list or dictionary corrected,
 * so they are exactly where the donor disagrees.
 */
export function borrowPunctuation(target: string, donor: string, options: { substitutions?: boolean } = {}): string {
  const targetTokens = tokenize(target)
  const donorTokens = tokenize(donor)
  if (!targetTokens.length || !donorTokens.length) return target

  const pairs = alignTokens(targetTokens, donorTokens)
  for (const [i, j] of pairs) {
    const t = targetTokens[i]!
    const d = donorTokens[j]!
    const donorMarks = d.trail.match(MARKS)?.[0] ?? ''
    t.trail = t.trail.replace(MARKS, '') + donorMarks
    if (t.core === t.core.toLowerCase() && d.core !== d.core.toLowerCase()) t.core = d.core
  }
  if (options.substitutions) {
    for (const [i, j] of substitutionPairs(pairs, targetTokens.length, donorTokens.length)) {
      const t = targetTokens[i]!
      const d = donorTokens[j]!
      const donorMarks = d.trail.match(MARKS)?.[0] ?? ''
      if (donorMarks) t.trail = t.trail.replace(MARKS, '') + donorMarks
      const first = d.core.charAt(0)
      if (first !== first.toLowerCase() && t.core.charAt(0) === t.core.charAt(0).toLowerCase()) {
        t.core = t.core.charAt(0).toUpperCase() + t.core.slice(1)
      }
    }
  }
  return targetTokens.map((token) => token.lead + token.core + token.trail).join(' ')
}

/** Unmatched runs of equal length on both sides between (and around) matches, paired in order. */
function substitutionPairs(pairs: Array<[number, number]>, rows: number, cols: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const bounds: Array<[number, number]> = [[-1, -1], ...pairs, [rows, cols]]
  for (let k = 1; k < bounds.length; k++) {
    const [i0, j0] = bounds[k - 1]!
    const [i1, j1] = bounds[k]!
    if (i1 - i0 !== j1 - j0) continue
    for (let n = 1; n < i1 - i0; n++) out.push([i0 + n, j0 + n])
  }
  return out
}

export function tokenize(text: string): Token[] {
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
export function alignTokens(a: Token[], b: Token[]): Array<[number, number]> {
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
