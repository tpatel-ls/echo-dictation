import type { DictionaryEntry } from './types'

export interface ApplyResult {
  text: string
  appliedIds: number[]
}

export interface Correction {
  from: string
  to: string
}

// ── Deterministic replacement layer ──────────────────────────────────────────

// \b is ASCII-only; these lookarounds give unicode-aware whole-word boundaries.
const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}])'
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}])'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Case-insensitive whole-word matcher; multi-word aliases tolerate any whitespace. */
function aliasPattern(alias: string): RegExp {
  const tokens = alias.trim().split(/\s+/).map(escapeRegex)
  return new RegExp(BOUNDARY_BEFORE + tokens.join('\\s+') + BOUNDARY_AFTER, 'giu')
}

/**
 * Replace every misheard alias with its entry's canonical word. The canonical word
 * itself also acts as an alias so wrong casing gets fixed ("github" → "GitHub").
 * Longer aliases run first so "mac mini" wins over "mac". Returns the ids of entries
 * that actually changed the text (drives `times_applied`).
 */
export function applyDictionary(text: string, entries: DictionaryEntry[]): ApplyResult {
  const pairs: Array<{ alias: string; entry: DictionaryEntry }> = []
  for (const entry of entries) {
    const word = entry.word.trim()
    if (!word) continue
    const seen = new Set<string>()
    for (const alias of [word, ...entry.misheard]) {
      const a = alias.trim().replace(/\s+/g, ' ')
      const key = a.toLowerCase()
      if (!a || seen.has(key)) continue
      seen.add(key)
      pairs.push({ alias: a, entry })
    }
  }
  pairs.sort(
    (a, b) =>
      b.alias.split(' ').length - a.alias.split(' ').length || b.alias.length - a.alias.length
  )

  let out = text
  const applied = new Set<number>()
  for (const { alias, entry } of pairs) {
    out = out.replace(aliasPattern(alias), (match) => {
      if (match === entry.word) return match // already correct — not an application
      applied.add(entry.id)
      return entry.word
    })
  }
  return { text: out, appliedIds: [...applied] }
}

// ── Whisper bias prompt ───────────────────────────────────────────────────────

/**
 * Comma-joined canonical words (never aliases — they would bias toward the wrong
 * spelling), most-used then most-recent first, truncated to a character budget that
 * stays safely under Whisper's 224-token prompt window.
 */
export function buildBiasPrompt(entries: DictionaryEntry[], maxChars = 600): string {
  const sorted = [...entries].sort(
    (a, b) => b.times_applied - a.times_applied || b.created_at - a.created_at
  )
  let out = ''
  for (const e of sorted) {
    const word = e.word.trim()
    if (!word) continue
    const next = out ? `${out}, ${word}` : word
    if (next.length > maxChars) break
    out = next
  }
  return out
}

// ── Learning: diff an edited transcript against the original ─────────────────

interface Token {
  raw: string
  norm: string // raw with leading/trailing punctuation stripped
}

function tokenize(s: string): Token[] {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({ raw, norm: raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') }))
}

interface Chunk {
  removed: Token[]
  added: Token[]
}

/** Word-level LCS diff (case-sensitive on normalized tokens) → substitution chunks. */
function diffChunks(a: Token[], b: Token[]): Chunk[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i].norm === b[j].norm ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])

  const chunks: Chunk[] = []
  let removed: Token[] = []
  let added: Token[] = []
  const flush = (): void => {
    if (removed.length || added.length) chunks.push({ removed, added })
    removed = []
    added = []
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i].norm === b[j].norm) {
      flush()
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed.push(a[i++])
    } else {
      added.push(b[j++])
    }
  }
  while (i < n) removed.push(a[i++])
  while (j < m) added.push(b[j++])
  flush()
  return chunks
}

/** No letters at all → a number/punctuation swap, not a vocabulary correction. */
function isNonWord(s: string): boolean {
  return !/\p{L}/u.test(s)
}

/**
 * "brian" → "Brian" is sentence-case noise (Whisper handles that contextually), but
 * "github" → "GitHub" is a real casing preference: keep only changes past char 0.
 */
function isSentenceCaseOnly(from: string, to: string): boolean {
  return from.toLowerCase() === to.toLowerCase() && from.slice(1) === to.slice(1)
}

const MAX_PHRASE_WORDS = 3
const REWRITE_RATIO = 0.4
const REWRITE_MIN_WORDS = 8

/**
 * Extract dictionary-worthy corrections from a transcript edit. Substitutions only
 * (insertions/deletions are editing, not mishearing), at most 3 words per side, and
 * nothing at all when the edit rewrote >40% of a reasonably long transcript.
 */
export function extractCorrections(before: string, after: string): Correction[] {
  const a = tokenize(before)
  const b = tokenize(after)
  if (!a.length || !b.length) return []

  const chunks = diffChunks(a, b)
  const changedTokens = chunks.reduce((sum, c) => sum + c.removed.length, 0)
  if (a.length >= REWRITE_MIN_WORDS && changedTokens / a.length > REWRITE_RATIO) return []

  const out: Correction[] = []
  for (const { removed, added } of chunks) {
    if (!removed.length || !added.length) continue
    if (removed.length > MAX_PHRASE_WORDS || added.length > MAX_PHRASE_WORDS) continue
    const from = removed.map((t) => t.norm).join(' ').trim()
    const to = added.map((t) => t.norm).join(' ').trim()
    if (!from || !to || from === to) continue
    if (isNonWord(from) || isNonWord(to)) continue
    if (isSentenceCaseOnly(from, to)) continue
    out.push({ from, to })
  }
  return out
}
