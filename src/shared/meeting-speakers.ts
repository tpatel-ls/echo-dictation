// ─────────────────────────────────────────────────────────────────────────────
// Speaker naming. A name is shown only when it is certain: the user's own (the mic channel), a
// remembered voice that matches clearly, or a meeting-window hint when exactly one remote person
// spoke. Anything else is "Speaker N", with a likely name offered as a one-click suggestion.
// Spec: "Speaker names"; thresholds from the GB10 research notes (§5.3).
// ─────────────────────────────────────────────────────────────────────────────

import type { MeetingAppId, MeetingChannel, MeetingSpeaker, SpeakerKey } from './meeting-types'
import { OTHERS_SPEAKER_KEY, SELF_SPEAKER_KEY } from './meeting-types'

export interface SpeakerEvidence {
  key: SpeakerKey
  channel: MeetingChannel
  seconds: number
  /** Unit-length voice centroid from the diarizer, or null when it had too little speech. */
  embedding: number[] | null
  firstStartMs: number
}

export interface VoiceprintCandidate {
  personId: number
  name: string
  exemplars: Array<{ embedding: number[]; sourceApp: string }>
}

export interface NamingOptions {
  userName: string
  /** Cosine at or above which a voice is named automatically... */
  accept: number
  /** ...or offered as a suggestion. */
  suggest: number
  /** Lead an automatic match needs over the same speaker's next-best person. */
  margin: number
  /** Speech a speaker needs before a voiceprint may name them. */
  minMatchSeconds: number
  /** Speech the single remote speaker needs before a window-title hint may name them. */
  minHintSeconds: number
}

export const DEFAULT_NAMING: Omit<NamingOptions, 'userName'> = {
  accept: 0.7,
  suggest: 0.55,
  margin: 0.1,
  minMatchSeconds: 5,
  minHintSeconds: 10
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function selfLabel(userName: string): string {
  return userName.trim() || 'You'
}

/** The one distinct hint (case-insensitive), as first written, or null for none or several. */
function singleHint(nameHints: string[]): string | null {
  const distinct: string[] = []
  for (const h of nameHints.map((n) => n.trim()).filter(Boolean)) {
    if (!distinct.some((d) => sameName(d, h))) distinct.push(h)
  }
  return distinct.length === 1 ? distinct[0] : null
}

/** "Speaker 1", "Speaker 2", … over the unknown speakers, in list order. */
export function numberUnknown(speakers: MeetingSpeaker[]): MeetingSpeaker[] {
  let n = 0
  return speakers.map((s) => (s.source === 'unknown' ? { ...s, label: `Speaker ${++n}` } : s))
}

interface Pair {
  speaker: number
  person: number
  score: number
}

export function nameSpeakers(
  speakers: SpeakerEvidence[],
  people: VoiceprintCandidate[],
  nameHints: string[],
  // Part of the contract for source-aware matching (Meet vs Slack codecs); not used by the rules yet.
  _sourceApp: MeetingAppId,
  opts: NamingOptions
): MeetingSpeaker[] {
  const ordered = speakers
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        Number(b.s.key === SELF_SPEAKER_KEY) - Number(a.s.key === SELF_SPEAKER_KEY) ||
        a.s.firstStartMs - b.s.firstStartMs ||
        a.i - b.i
    )
    .map(({ s }) => s)

  // Score every (speaker, person) pair: a person's best exemplar of the same dimension.
  const scores = new Map<number, Map<number, number>>()
  const pairs: Pair[] = []
  ordered.forEach((s, si) => {
    const row = new Map<number, number>()
    scores.set(si, row)
    if (s.key === SELF_SPEAKER_KEY || !s.embedding) return
    people.forEach((p, pi) => {
      let best = -Infinity
      for (const ex of p.exemplars) {
        if (ex.embedding.length === s.embedding!.length) best = Math.max(best, cosine(s.embedding!, ex.embedding))
      }
      if (best === -Infinity) return
      row.set(pi, best)
      pairs.push({ speaker: si, person: pi, score: best })
    })
  })
  const runnerUp = (si: number, pi: number): number => {
    let best = -Infinity
    for (const [other, score] of scores.get(si)!) if (other !== pi) best = Math.max(best, score)
    return best
  }

  // Exclusive automatic matches, greedily from the highest score down.
  pairs.sort((a, b) => b.score - a.score || a.speaker - b.speaker || a.person - b.person)
  const autoBySpeaker = new Map<number, Pair>()
  const autoPeople = new Set<number>()
  for (const pair of pairs) {
    if (autoBySpeaker.has(pair.speaker) || autoPeople.has(pair.person)) continue
    const ok =
      pair.score >= opts.accept &&
      ordered[pair.speaker].seconds >= opts.minMatchSeconds &&
      pair.score - runnerUp(pair.speaker, pair.person) >= opts.margin
    if (!ok) continue
    autoBySpeaker.set(pair.speaker, pair)
    autoPeople.add(pair.person)
  }

  // Suggestions: each remaining speaker's best person not already matched to someone else.
  const suggestionFor = new Map<number, Pair>()
  for (const pair of pairs) {
    if (autoBySpeaker.has(pair.speaker) || suggestionFor.has(pair.speaker) || autoPeople.has(pair.person)) continue
    if (pair.score >= opts.suggest) suggestionFor.set(pair.speaker, pair)
  }

  // The window-title hint names the one substantial remote voice, unless voiceprints disagree.
  const hint = singleHint(nameHints)
  const remote = ordered
    .map((s, si) => ({ s, si }))
    .filter(({ s }) => s.channel === 'others' && s.key !== SELF_SPEAKER_KEY && s.seconds >= opts.minHintSeconds)
  let hinted: number | null = null
  if (hint && remote.length === 1 && !autoBySpeaker.has(remote[0].si)) {
    const taken = [...autoBySpeaker.values()].some((p) => sameName(people[p.person].name, hint))
    if (!taken) hinted = remote[0].si
  }

  const named = ordered.map((s, si): MeetingSpeaker => {
    const base = { key: s.key, personId: null, suggestion: null, score: null, seconds: s.seconds }
    if (s.key === SELF_SPEAKER_KEY) return { ...base, label: selfLabel(opts.userName), source: 'self' }
    const auto = autoBySpeaker.get(si)
    if (auto) {
      return { ...base, label: people[auto.person].name, source: 'voiceprint', personId: people[auto.person].personId, score: auto.score }
    }
    const suggested = suggestionFor.get(si)
    const suggestion = suggested ? { suggestion: people[suggested.person].name, score: suggested.score } : {}
    if (si === hinted) return { ...base, ...suggestion, label: hint!, source: 'hint' }
    return { ...base, ...suggestion, label: '', source: 'unknown' }
  })
  return numberUnknown(named)
}

/**
 * The user names a speaker. Any other speaker showing that name only because a voiceprint or a
 * hint put it there goes back to unknown, and the "Speaker N" numbering closes up.
 */
export function renameSpeaker(
  speakers: MeetingSpeaker[],
  key: SpeakerKey,
  name: string,
  personId: number | null
): MeetingSpeaker[] {
  if (!speakers.some((s) => s.key === key)) return speakers.map((s) => ({ ...s }))
  const renamed = speakers.map((s): MeetingSpeaker => {
    if (s.key === key) return { ...s, label: name, source: 'user', personId, suggestion: null }
    if (s.source !== 'user' && s.source !== 'self' && s.source !== 'unknown' && sameName(s.label, name)) {
      return { ...s, source: 'unknown', personId: null }
    }
    return { ...s }
  })
  return numberUnknown(renamed)
}

/** Labels for the live transcript: the user, and the undiarized remote channel. */
export function liveSpeakers(userName: string, nameHints: string[]): MeetingSpeaker[] {
  const hint = singleHint(nameHints)
  const blank = { personId: null, suggestion: null, score: null, seconds: 0 }
  return [
    { key: SELF_SPEAKER_KEY, label: selfLabel(userName), source: 'self', ...blank },
    { key: OTHERS_SPEAKER_KEY, label: hint ?? 'Others', source: hint ? 'hint' : 'unknown', ...blank }
  ]
}
