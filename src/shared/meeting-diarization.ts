// ─────────────────────────────────────────────────────────────────────────────
// Clean-up of one channel's diarization before speakers are named. pyannote tends to give a
// person's short backchannels ("Mm-hmm", "Okay", "Yeah") a cluster of their own: their embeddings
// are noisy, so the cluster sits apart from the same person's real answers. Such a minor cluster
// folds into the major speaker it sounds most like; two major clusters of the same voice merge;
// and when the calendar says one person is on the channel, everyone is that person. Pure.
// ─────────────────────────────────────────────────────────────────────────────

import { cosine } from './meeting-speakers'
import type { DiarizationResult, DiarizedSpeaker } from './meeting-types'

export interface MergeOptions {
  /** A speaker with less speech than this... */
  minorSeconds: number
  /** ...or less than this share of the channel's speech is minor. */
  minorShare: number
  /**
   * A minor speaker folds into its closest major speaker at or above this centroid cosine.
   * Calibrated on real and synthetic meetings: one person's backchannel cluster against their
   * answers scored 0.298 (a real interview); different voices scored 0.17-0.20 (synthetic), and
   * different people 0.05-0.16 (the same interview).
   */
  minorCosine: number
  /** Two major speakers merge at or above this cosine (the same voice split in two). */
  majorCosine: number
}

export const DEFAULT_MERGE: MergeOptions = { minorSeconds: 20, minorShare: 0.1, minorCosine: 0.25, majorCosine: 0.75 }

/** Two speakers with this much simultaneous speech are two people (boundary jitter is far less). */
const SAME_TIME_S = 1

export interface SpeakerMerge {
  from: string
  into: string
  reason: 'minor' | 'minor-no-embedding' | 'same-voice' | 'single-attendee'
  /** Centroid cosine between the two, when both had an embedding. */
  cosine: number | null
}

/** Seconds during which both speakers are talking. */
function overlapSeconds(turns: DiarizationResult['segments'], a: string, b: string): number {
  const ta = turns.filter((t) => t.speaker === a)
  const tb = turns.filter((t) => t.speaker === b)
  let total = 0
  for (const x of ta) for (const y of tb) total += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start))
  return total
}

function round(x: number, places: number): number {
  const f = 10 ** places
  return Math.round(x * f) / f
}

/**
 * Merge over-split speakers. `expectedSpeakers: 1` (the calendar's only other attendee, on the
 * others channel) folds every speaker into the one with the most speech.
 */
export function mergeSpeakers(
  result: DiarizationResult,
  opts: Partial<MergeOptions> & { expectedSpeakers?: number } = {}
): { result: DiarizationResult; merges: SpeakerMerge[] } {
  const o = { ...DEFAULT_MERGE, ...opts }
  if (result.speakers.length < 2) return { result, merges: [] }
  const bySpeech = [...result.speakers].sort((a, b) => b.speechSeconds - a.speechSeconds || a.id.localeCompare(b.id))
  const total = bySpeech.reduce((sum, s) => sum + s.speechSeconds, 0)
  const into = new Map<string, string>()
  const merges: SpeakerMerge[] = []
  const cos = (a: DiarizedSpeaker, b: DiarizedSpeaker): number | null =>
    a.embedding && b.embedding ? round(cosine(a.embedding, b.embedding), 3) : null

  if (opts.expectedSpeakers === 1) {
    const main = bySpeech[0]
    for (const s of bySpeech.slice(1)) {
      into.set(s.id, main.id)
      merges.push({ from: s.id, into: main.id, reason: 'single-attendee', cosine: cos(s, main) })
    }
  } else {
    const isMinor = (s: DiarizedSpeaker): boolean => s.speechSeconds < o.minorSeconds || (total > 0 && s.speechSeconds / total < o.minorShare)
    let majors = bySpeech.filter((s) => !isMinor(s))
    if (majors.length === 0) majors = [bySpeech[0]]
    const minors = bySpeech.filter((s) => !majors.includes(s))

    // Major clusters of one voice that never talk at the same time: fold the smaller into the larger.
    const kept: DiarizedSpeaker[] = []
    for (const s of majors) {
      const twin = kept.find((k) => (cos(s, k) ?? -1) >= o.majorCosine && overlapSeconds(result.segments, s.id, k.id) < SAME_TIME_S)
      if (twin) {
        into.set(s.id, twin.id)
        merges.push({ from: s.id, into: twin.id, reason: 'same-voice', cosine: cos(s, twin) })
      } else {
        kept.push(s)
      }
    }
    for (const s of minors) {
      if (!s.embedding) {
        if (kept.length === 1) {
          into.set(s.id, kept[0].id)
          merges.push({ from: s.id, into: kept[0].id, reason: 'minor-no-embedding', cosine: null })
        }
        continue
      }
      let best: { major: DiarizedSpeaker; score: number } | null = null
      for (const major of kept) {
        const score = cos(s, major)
        if (score !== null && score >= o.minorCosine && (!best || score > best.score)) best = { major, score }
      }
      if (best) {
        into.set(s.id, best.major.id)
        merges.push({ from: s.id, into: best.major.id, reason: 'minor', cosine: best.score })
      }
    }
  }
  if (merges.length === 0) return { result, merges }

  const target = (id: string): string => into.get(id) ?? id
  const speakers = result.speakers
    .filter((s) => !into.has(s.id))
    .map((s) => {
      const members = result.speakers.filter((m) => target(m.id) === s.id)
      return {
        ...s,
        speechSeconds: round(members.reduce((sum, m) => sum + m.speechSeconds, 0), 2),
        turns: members.reduce((sum, m) => sum + m.turns, 0)
      }
    })
  const segments = result.segments.map((t) => ({ ...t, speaker: target(t.speaker) }))
  return { result: { ...result, speakers, segments }, merges }
}
