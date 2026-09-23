// ─────────────────────────────────────────────────────────────────────────────
// Meeting transcript assembly: diarized turns → decodable segments → batches, choosing between two
// models' texts per segment, separating the local user from bleed on the mic channel, and merging
// the result into readable utterances. Pure. Spec: "Final pass" and "Live transcript".
// ─────────────────────────────────────────────────────────────────────────────

import { quietestPoint } from './meeting-audio'
import { borrowPunctuation } from './punctuation-transfer'
import type { AsrSegment, DiarizationResult, DiarizedTurn, MeetingUtterance } from './meeting-types'
import { MEETING_SAMPLE_RATE } from './meeting-types'

// ── Segments ──────────────────────────────────────────────────────────────────

export interface SegmentBuildOptions {
  /** Same-speaker turns closer than this merge. */
  mergeGapS: number
  /** Longest segment sent to a model (Canary-Qwen was trained on ≤ 40 s). */
  maxS: number
  /** Context added on both sides of each segment. */
  padS: number
  /** Shorter segments fold into a same-speaker neighbour when one is close... */
  minS: number
  /** ...and are dropped when isolated and shorter than this. */
  dropIsolatedS: number
}

const DEFAULT_SEGMENT_OPTIONS: SegmentBuildOptions = { mergeGapS: 0.8, maxS: 30, padS: 0.2, minS: 0.6, dropIsolatedS: 0.3 }

interface Span {
  start: number
  end: number
  speaker: string
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}

function mergeClose(spans: Span[], gapS: number): Span[] {
  const out: Span[] = []
  for (const s of spans) {
    const last = out[out.length - 1]
    // Gaps compare at millisecond precision: 6.8 - 6.0 is 0.7999… in floating point.
    if (last && last.speaker === s.speaker && round3(s.start - last.end) < gapS) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** Cut points splitting [start, end] into pieces ≤ maxS, at quiet moments when audio is given. */
function splitPoints(span: Span, samples: Int16Array | null, maxS: number): number[] {
  const cuts: number[] = []
  let start = span.start
  const end = span.end
  while (end - start > maxS) {
    const length = end - start
    const needed = Math.ceil(length / maxS)
    if (!samples || samples.length < Math.ceil(end * MEETING_SAMPLE_RATE)) {
      // No audio to listen to: equal pieces.
      for (let k = 1; k < needed; k++) cuts.push(start + (length * k) / needed)
      break
    }
    // Keep both sides at least maxS/2 when two pieces suffice, so no sliver is left over.
    const hi = Math.min(start + maxS, end - maxS / 2)
    const lo = length <= 2 * maxS ? Math.max(end - maxS, start + maxS / 2) : start + maxS / 2
    const at = quietestPoint(samples, Math.round(lo * MEETING_SAMPLE_RATE), Math.round(hi * MEETING_SAMPLE_RATE))
    const cut = Math.min(hi, Math.max(lo, at / MEETING_SAMPLE_RATE))
    cuts.push(cut)
    start = cut
  }
  return cuts
}

/**
 * Speaker-homogeneous clips to decode, from exclusive diarization turns: close same-speaker turns
 * merged, blips under `dropIsolatedS` with no same-speaker neighbour dropped (which can rejoin the
 * turns they interrupted), long stretches split at quiet points, and each padded for context.
 */
export function buildAsrSegments(
  turns: DiarizedTurn[],
  samples: Int16Array | null,
  totalSeconds: number,
  idPrefix: string,
  opts: Partial<SegmentBuildOptions> = {}
): AsrSegment[] {
  const o = { ...DEFAULT_SEGMENT_OPTIONS, ...opts }
  const sorted = turns
    .map((t) => ({ start: Math.max(0, t.start), end: Math.min(totalSeconds, t.end), speaker: t.speaker }))
    .filter((t) => t.end > t.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)

  // After merging, a segment under minS has no same-speaker neighbour within mergeGapS (it would
  // have folded in), so it is isolated: dropped under dropIsolatedS, else kept. Drop one blip at a
  // time and merge again, since removing a blip can make the turns it interrupted adjacent.
  let spans = mergeClose(sorted, o.mergeGapS)
  for (;;) {
    const i = spans.findIndex((s) => s.end - s.start < Math.min(o.minS, o.dropIsolatedS))
    if (i < 0) break
    spans.splice(i, 1)
    spans = mergeClose(spans, o.mergeGapS)
  }

  const pieces: Span[] = []
  for (const s of spans) {
    let start = s.start
    for (const cut of splitPoints(s, samples, o.maxS)) {
      pieces.push({ start, end: cut, speaker: s.speaker })
      start = cut
    }
    pieces.push({ start, end: s.end, speaker: s.speaker })
  }

  // Pad each side by up to padS, sharing a small gap so neighbours never overlap by more than padS.
  const reach = (gap: number): number => Math.max(0, Math.min(o.padS, (gap + o.padS) / 2))
  return pieces.map((p, n) => {
    const before = n > 0 ? reach(p.start - pieces[n - 1].end) : o.padS
    const after = n < pieces.length - 1 ? reach(pieces[n + 1].start - p.end) : o.padS
    return {
      id: `${idPrefix}${n}`,
      start: round3(Math.max(0, p.start - before)),
      end: round3(Math.min(totalSeconds, p.end + after)),
      speaker: p.speaker
    }
  })
}

export interface SegmentBatch {
  start: number
  end: number
  segments: AsrSegment[]
}

/** Consecutive segments grouped so each batch spans ≤ maxBatchSeconds; a segment is never split. */
export function batchSegments(segments: AsrSegment[], maxBatchSeconds = 300): SegmentBatch[] {
  const batches: SegmentBatch[] = []
  const sorted = [...segments].sort((a, b) => a.start - b.start)
  for (const s of sorted) {
    const last = batches[batches.length - 1]
    if (last && Math.max(last.end, s.end) - last.start <= maxBatchSeconds) {
      last.segments.push(s)
      last.end = Math.max(last.end, s.end)
    } else {
      batches.push({ start: s.start, end: s.end, segments: [s] })
    }
  }
  return batches
}

// ── Text choice ───────────────────────────────────────────────────────────────

/** Lower-case, punctuation-free, single-spaced: for comparing texts only, never for output. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(text: string): string[] {
  const n = normalize(text)
  return n ? n.split(' ') : []
}

/** Share of `words` found in `pool`, counting repeats (a loop repeating one phrase scores low). */
function containment(words: string[], pool: string[]): number {
  if (words.length === 0) return 0
  const left = new Map<string, number>()
  for (const w of pool) left.set(w, (left.get(w) ?? 0) + 1)
  let hits = 0
  for (const w of words) {
    const n = left.get(w) ?? 0
    if (n > 0) {
      hits++
      left.set(w, n - 1)
    }
  }
  return hits / words.length
}

/** What speech models say to silence and noise (subtitle-trained decoders especially). */
const SILENCE_HALLUCINATIONS = new Set([
  'thank you',
  'thank you very much',
  'thank you for watching',
  'thanks for watching',
  'you',
  'bye',
  'bye bye'
])

/** A hummed backchannel, as the models spell it. */
function isHum(normalized: string): boolean {
  return /^(?:m+|m+ ?h+m+|mh+m+|h+m+|uh ?huh|m+ ?hm+)$/.test(normalized.replace(/-/g, ' '))
}

/** Clips shorter than this are where an LLM decoder invents words ("Amen" for "Mm-hmm"). */
export const SHORT_CLIP_S = 1.5
/** On a short clip the primary needs this share of its words in the check to be trusted. */
const SHORT_CLIP_AGREEMENT = 0.5

/**
 * The text to keep for one segment, given each model's output. The primary (most accurate) model
 * wins unless the cross-check shows it invented speech: text over silence, or a runaway decode
 * much longer than, and mostly unlike, the check. On a clip shorter than `SHORT_CLIP_S` (when
 * `seconds` is given) the primary must broadly agree with the check, or the check's text is used.
 * A check model that failed on the segment (absent from `texts`) is no evidence either way, so the
 * primary stands.
 */
export function chooseSegmentText(texts: Record<string, string>, primary: string, check: string, seconds?: number): string {
  const p = (texts[primary] ?? '').trim()
  const c = (texts[check] ?? '').trim()
  if (!normalize(p)) return c
  if (!(check in texts)) return p
  const pn = normalize(p)
  const cn = normalize(c)
  if (seconds !== undefined && seconds < SHORT_CLIP_S && primary !== check && cn) {
    if (containment(tokens(p), tokens(c)) >= SHORT_CLIP_AGREEMENT) return p
    // Models turn a hum into a word ("Okay.", "Amen"); when either heard a hum, it was one.
    return isHum(pn) || isHum(cn) ? 'Mm-hmm' : c
  }
  if (!cn) {
    if (tokens(p).length <= 3 || SILENCE_HALLUCINATIONS.has(pn)) return ''
    return p
  }
  if (pn.length > 1.6 * cn.length && containment(tokens(p), tokens(c)) < 0.5) return c
  return p
}

/** Sentence-ending marks, as the models place them. */
function sentenceMarks(text: string): number {
  return text.match(/[.!?…](?=\s|$|["')])/g)?.length ?? 0
}
/** The check must share this much of the text's words before its punctuation is borrowed. */
const PUNCTUATION_AGREEMENT = 0.6

/**
 * The chosen text with the check model's sentence breaks and capitals, when the check is better
 * punctuated and heard broadly the same words. Granite given a keyword list often drops sentence
 * punctuation, while Parakeet keeps it; words are never taken from the check.
 */
export function punctuateFromCheck(text: string, check: string): string {
  if (!check.trim() || sentenceMarks(check) <= sentenceMarks(text)) return text
  if (containment(tokens(text), tokens(check)) < PUNCTUATION_AGREEMENT) return text
  return borrowPunctuation(text, check, { substitutions: true })
}

/** Hesitation sounds that carry nothing on their own. Backchannels ("Mm-hmm", "Yeah") are not here. */
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'hmm', 'hm', 'mm', 'mmm', 'er', 'erm', 'ah', 'eh'])

/** A line that is only fillers ("Um", "Uh, um"), dropped from the transcript. */
export function isFillerOnly(text: string): boolean {
  const words = text.toLowerCase().replace(/[^\p{L}\s-]/gu, ' ').split(/\s+/).filter(Boolean)
  return words.length > 0 && words.every((w) => FILLERS.has(w))
}

// ── Mic channel: who is "me", and what is bleed ───────────────────────────────

/** The mic channel's main voice: the diarized speaker with the most speech. */
export function selfSpeakerLabel(result: DiarizationResult): string | null {
  let best: { id: string; speechSeconds: number } | null = null
  for (const s of result.speakers) if (!best || s.speechSeconds > best.speechSeconds) best = s
  return best?.id ?? null
}

function overlapSeconds(start: number, end: number, turns: DiarizedTurn[]): number {
  let total = 0
  for (const t of turns) total += Math.max(0, Math.min(end, t.end) - Math.max(start, t.start))
  return total
}

/**
 * Mic segments worth keeping: all of the user's own, and other voices only when they are not mostly
 * (≥ 50%) under others-channel speech, which would make them the far end leaking from speakers
 * rather than someone in the room.
 */
export function filterMicSegments(
  segments: AsrSegment[],
  selfLabel: string | null,
  othersTurns: DiarizedTurn[]
): AsrSegment[] {
  return segments.filter((s) => {
    if (selfLabel !== null && s.speaker === selfLabel) return true
    const length = s.end - s.start
    return length > 0 && overlapSeconds(s.start, s.end, othersTurns) / length < 0.5
  })
}

/** Mic text (≥ 2 words) that is ≥ 60% contained in what the others said at the same time. */
export function isBleed(micText: string, overlappingOthersTexts: string[]): boolean {
  const mic = tokens(micText)
  if (mic.length < 2) return false
  return containment(mic, tokens(overlappingOthersTexts.join(' '))) >= 0.6
}

/** Removes mic utterances that echo others utterances overlapping them (± toleranceMs). */
export function dropMicBleed(utterances: MeetingUtterance[], toleranceMs = 1500): MeetingUtterance[] {
  const others = utterances.filter((u) => u.channel === 'others')
  return utterances.filter((u) => {
    if (u.channel !== 'mic') return true
    const near = others.filter((o) => o.start < u.end + toleranceMs && o.end > u.start - toleranceMs)
    return !isBleed(
      u.text,
      near.map((o) => o.text)
    )
  })
}

/**
 * Two consecutive fragments of one speaker. Models leave the final period off a short clip ("That
 * is great news"), so a fragment without closing punctuation followed by one that starts with a
 * capital letter was a sentence of its own: close it.
 */
function joinFragments(a: string, b: string): string {
  const left = a.trim()
  const right = b.trim()
  if (!left || !right) return left || right
  const closed = /[.!?…:;,)"'\]]$/.test(left) || !/^\p{Lu}/u.test(right)
  return `${left}${closed ? '' : '.'} ${right}`
}

/**
 * Time-ordered utterances with adjacent same-speaker, same-channel ones closer than the gap joined,
 * never past `maxMs` long (notes cite utterances, so a whole monologue in one line is useless).
 */
export function mergeUtterances(utterances: MeetingUtterance[], mergeGapMs = 1500, maxMs = Infinity): MeetingUtterance[] {
  const sorted = utterances.map((u, i) => ({ u, i })).sort((a, b) => a.u.start - b.u.start || a.i - b.i)
  const out: MeetingUtterance[] = []
  for (const { u } of sorted) {
    const last = out[out.length - 1]
    if (
      last &&
      last.speakerKey === u.speakerKey &&
      last.channel === u.channel &&
      u.start - last.end < mergeGapMs &&
      Math.max(last.end, u.end) - last.start <= maxMs
    ) {
      last.end = Math.max(last.end, u.end)
      last.text = joinFragments(last.text, u.text)
    } else {
      out.push({ ...u })
    }
  }
  return out
}
