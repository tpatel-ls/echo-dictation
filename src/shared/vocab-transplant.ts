// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary transplant for the meeting final pass. Granite Speech, given the meeting's keyword
// list, spells names and company terms right ("Zeltra" where Canary heard "zebra") but also
// inserts listed names nobody said. So Granite never supplies the transcript: its words are
// only borrowed, one word for one word, where the chosen text (normally Canary's) heard
// something that sounds like a listed term. A word Granite added, dropped or merged is never
// taken, so a name can only replace a mishearing of itself, never appear from nothing. Pure.
// ─────────────────────────────────────────────────────────────────────────────

import { editDistance } from './name-correction'
import { alignTokens, tokenize, type Token } from './punctuation-transfer'

/** A disagreement longer than this is a different hearing of the clip, not a misheard word. */
const MAX_RUN = 3

/** Short words that never carry a name or a term; a keyword like "Ann" must not replace "and". */
const FUNCTION_WORDS = new Set(
  (
    "a an the and or but if of in on at to for from by with as is it its it's be am are was were " +
    "i i'm me my we us our you your he him his she her they them their this that these those " +
    'so no not yes do did done has have had can will would just then than there here'
  ).split(' ')
)
/** A contraction ("I'll", "we're", "don't", "it's") is never a name or a term. */
const CONTRACTION = /'(ll|re|ve|d|m|t)$/
const CONTRACTED_S = new Set(["it's", "he's", "she's", "that's", "what's", "there's", "here's", "let's", "who's", "where's", "how's"])

interface Terms {
  /** Lower-case word → its listed spelling: one-word keywords, and name-like parts of longer ones. */
  words: Map<string, string>
  /** "first second" (lower case) → the listed spelling of both words. */
  pairs: Map<string, [string, string]>
}

function lettersOf(word: string): string {
  return word.replace(/[^\p{L}\p{N}]/gu, '')
}

/** Lower case, curly apostrophes straightened, trailing possessive dropped. */
function base(word: string): string {
  return word.toLowerCase().replace(/’/g, "'").replace(/'s$/, '')
}

function termsOf(keywords: string[]): Terms {
  const words = new Map<string, string>()
  const pairs = new Map<string, [string, string]>()
  for (const keyword of keywords) {
    const parts = keyword.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 1 && lettersOf(parts[0]).length >= 2) words.set(base(parts[0]), parts[0])
    if (parts.length === 2) pairs.set(`${base(parts[0])} ${base(parts[1])}`, [parts[0], parts[1]])
    // A name-like part ("Jordan" of "Jordan Whitmore", "Claude" of "Claude Code", "NWG" of
    // "recruiting@NWG") is a term on its own; a lower-case or tiny part is not.
    const pieces = parts.flatMap((p) => p.split(/[@/_]+/)).filter(Boolean)
    if (pieces.length < 2) continue
    for (const part of pieces) {
      const letters = lettersOf(part)
      if (letters.length < 3 || !/^\p{Lu}/u.test(letters) || FUNCTION_WORDS.has(base(part))) continue
      if (!words.has(base(part))) words.set(base(part), letters)
    }
  }
  return { words, pairs }
}

/** The listed spelling for vocabulary word `j`, alone or with a neighbour as a two-word term. */
function listedSpelling(vocab: Token[], j: number, terms: Terms): string | null {
  const word = terms.words.get(base(vocab[j].core))
  if (word) return word
  const before = j > 0 ? terms.pairs.get(`${base(vocab[j - 1].core)} ${base(vocab[j].core)}`) : undefined
  if (before) return before[1]
  const after = j + 1 < vocab.length ? terms.pairs.get(`${base(vocab[j].core)} ${base(vocab[j + 1].core)}`) : undefined
  return after ? after[0] : null
}

/**
 * A rough sound key (a small Metaphone): spelling variants merged (ck, x, ph, soft c), sounds
 * that are easily confused in speech share a class, vowels drop out after the first letter.
 */
function soundKey(word: string): string {
  let w = word
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/^kn/, 'n')
    .replace(/^wr/, 'r')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/qu/g, 'kw')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/gh/g, '')
    .replace(/th/g, 't')
    .replace(/sh/g, 's')
  if (w.length > 3) w = w.replace(/e$/, '')
  let key = ''
  for (let i = 0; i < w.length; i++) {
    const ch = w[i]
    let cls: string
    if ('aeiouyhw'.includes(ch)) cls = i === 0 && 'aeiou'.includes(ch) ? 'A' : ''
    else if ('bp'.includes(ch)) cls = 'P'
    else if ('dt'.includes(ch)) cls = 'T'
    else if ('gkjq'.includes(ch)) cls = 'K'
    else if ('fv'.includes(ch)) cls = 'F'
    else if ('sz'.includes(ch)) cls = 'S'
    else cls = ch.toUpperCase()
    if (cls && !key.endsWith(cls)) key += cls
  }
  return key
}

const ACRONYM = /^[A-Z]{2,6}$/

/**
 * Whether `heard` could be a mishearing of `listed`: two acronyms one letter apart, or words
 * whose sound keys start alike and differ by at most one class (two for longer keys).
 */
function soundsAlike(heard: string, listed: string): boolean {
  const a = lettersOf(heard)
  const b = lettersOf(listed)
  if (a.length < 2 || b.length < 2) return false
  if (ACRONYM.test(a) && ACRONYM.test(b)) {
    return a.length === b.length && [...a].filter((ch, i) => ch !== b[i]).length <= 1
  }
  const ka = soundKey(a)
  const kb = soundKey(b)
  if (!ka || !kb || ka[0] !== kb[0]) return false
  const longest = Math.max(ka.length, kb.length)
  const distance = editDistance(ka, kb)
  return distance <= (longest >= 4 ? 2 : 1) && distance < longest
}

/**
 * `chosen` with each word the vocabulary model heard as a listed term (`keywords`: dictionary
 * words, known people, calendar attendees) swapped in, only where it is a one-for-one
 * substitution between words both texts agree on and it sounds like the word it replaces. The
 * chosen text's punctuation and sentence capitals stay; the term takes its listed spelling.
 */
export function transplantVocabulary(
  chosen: string,
  vocab: string,
  keywords: string[]
): { text: string; swaps: Array<{ from: string; to: string }> } {
  const swaps: Array<{ from: string; to: string }> = []
  if (!chosen.trim() || !vocab.trim() || keywords.length === 0) return { text: chosen, swaps }
  const terms = termsOf(keywords)
  const target = tokenize(chosen)
  const donor = tokenize(vocab)
  const matched = alignTokens(target, donor)
  // Texts that share no word are two different hearings; only a one-word clip is compared whole.
  if (matched.length === 0 && (target.length > 1 || donor.length > 1)) return { text: chosen, swaps }
  const anchors: Array<[number, number]> = [[-1, -1], ...matched, [target.length, donor.length]]
  for (let k = 1; k < anchors.length; k++) {
    const [i0, j0] = anchors[k - 1]
    const [i1, j1] = anchors[k]
    const run = i1 - i0 - 1
    // Same number of words on both sides: anything else is an insertion or a deletion.
    if (run < 1 || run > MAX_RUN || run !== j1 - j0 - 1) continue
    for (let n = 1; n <= run; n++) {
      const t = target[i0 + n]
      const d = donor[j0 + n]
      const heard = base(t.core)
      if (!lettersOf(t.core) || FUNCTION_WORDS.has(heard) || terms.words.has(heard)) continue
      const lower = t.core.toLowerCase().replace(/’/g, "'")
      if (CONTRACTION.test(lower) || CONTRACTED_S.has(lower)) continue
      const listed = listedSpelling(donor, j0 + n, terms)
      if (!listed || !soundsAlike(t.core, d.core)) continue
      const possessive = /['’]s$/i.test(d.core) && !/['’]s$/i.test(listed) ? "'s" : ''
      let core = listed + possessive
      if (/^\p{Lu}/u.test(t.core) && /^\p{Ll}/u.test(core)) core = core.charAt(0).toUpperCase() + core.slice(1)
      swaps.push({ from: t.core, to: core })
      t.core = core
    }
  }
  if (swaps.length === 0) return { text: chosen, swaps }
  return { text: target.map((t) => t.lead + t.core + t.trail).join(' '), swaps }
}
