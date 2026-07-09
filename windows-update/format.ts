// Small pure formatting/estimation helpers shared across processes.

export function wordCount(text: string): number {
  const t = text.trim()
  if (!t) return 0
  return t.split(/\s+/).length
}

const FILLERS = /\b(?:um+|uh+|erm+|hmm+)\b/i
const STUTTER = /\b(\w+)\s+\1\b/i
const META_DIRECTIONS = /\b(?:email|write that|say that|scratch that|bullet)\b/i
const MAX_INSTANT_WORDS = 12

/**
 * Fast path: a short dictation Whisper already punctuated cleanly (capitalized start, terminal
 * punctuation, no fillers/stutters, no breaks, no spoken directions) gains nothing from the AI
 * pass — skip it and insert instantly. Anything doubtful returns true and gets cleaned.
 */
export function needsAiCleanup(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (wordCount(t) > MAX_INSTANT_WORDS) return true
  if (t.includes('\n')) return true
  if (FILLERS.test(t) || STUTTER.test(t) || META_DIRECTIONS.test(t)) return true
  if (!/^["'(]?[A-Z0-9]/.test(t)) return true
  if (!/[.!?…]["')]?$/.test(t)) return true
  return false
}

// Value of dictating instead of typing: estimated time to *type* the same text
// at ~40 wpm. (Speaking is faster, so this approximates time saved.)
export function estimatedSecondsSaved(words: number): number {
  const typingWpm = 40
  return Math.round((words / typingWpm) * 60)
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function relativeTime(then: number, now: number): string {
  const diff = Math.max(0, now - then)
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.floor(d / 7)
  return `${w}w ago`
}
