// Pure view helpers for the Meetings page and the meeting pill: grouping, time formats,
// utterance numbering, and speaker labels/colours. No DOM access, so they are unit-tested.
import {
  OTHERS_SPEAKER_KEY,
  SELF_SPEAKER_KEY,
  type MeetingSegment,
  type MeetingSpeaker,
  type MeetingSummary
} from '@shared/meeting-types'

const DAY_MS = 86_400_000

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 'Today', 'Yesterday', or a short date such as 'Mon, Sep 1'. */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear()
  return new Date(ts).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric'
  })
}

export interface DayGroup {
  label: string
  items: MeetingSummary[]
}

/** Consecutive meetings on the same calendar day share a group; the input order is kept. */
export function groupByDay(meetings: MeetingSummary[], now: number = Date.now()): DayGroup[] {
  const groups: DayGroup[] = []
  let lastDay: number | null = null
  for (const meeting of meetings) {
    const day = startOfDay(meeting.started_at)
    if (day !== lastDay) {
      groups.push({ label: dayLabel(meeting.started_at, now), items: [] })
      lastDay = day
    }
    groups[groups.length - 1].items.push(meeting)
  }
  return groups
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Elapsed recording time: '04:07', or '1:02:05' once past an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** Transcript offset from the start of the recording: always 'hh:mm:ss'. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/** '< 1 min', '42 min', '1 h 5 min', '2 h'; empty while the meeting has no end. */
export function formatMeetingLength(start: number, end: number | null): string {
  if (end === null) return ''
  const minutes = Math.round((end - start) / 60_000)
  if (minutes < 1) return '< 1 min'
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Segments in transcript order. */
export function orderedSegments(segments: MeetingSegment[]): MeetingSegment[] {
  return [...segments].sort((a, b) => a.idx - b.idx)
}

/** Segment id → utterance id ('u1', 'u2', ...), numbered in segment order as notes cite them. */
export function utteranceIds(segments: MeetingSegment[]): Map<number, string> {
  return new Map(orderedSegments(segments).map((s, i) => [s.id, `u${i + 1}`]))
}

/** The speaker's display name, or a readable fallback when the meeting has none for the key. */
export function speakerLabel(key: string, speakers: MeetingSpeaker[]): string {
  const known = speakers.find((s) => s.key === key)
  if (known?.label) return known.label
  if (key === SELF_SPEAKER_KEY) return 'You'
  if (key === OTHERS_SPEAKER_KEY) return 'Others'
  const n = /(\d+)$/.exec(key)
  return n ? `Speaker ${Number(n[1]) + 1}` : 'Speaker'
}

/** Text colours for remote speakers; the local user is styled separately with the accent. */
export const SPEAKER_PALETTE = ['#0e7490', '#b45309', '#be185d', '#15803d', '#7c3aed', '#b91c1c', '#0369a1', '#4d7c0f']

/** Remote speaker key → colour, assigned in key order so a speaker keeps its colour on reload. */
export function speakerColors(segments: MeetingSegment[]): Map<string, string> {
  const keys = [...new Set(segments.map((s) => s.speaker_key))]
    .filter((k) => k !== SELF_SPEAKER_KEY)
    .sort()
  return new Map(keys.map((k, i) => [k, SPEAKER_PALETTE[i % SPEAKER_PALETTE.length]]))
}

/** Up to `max` names for a compact row, plus how many were left out. */
export function visibleNames(names: string[], max = 3): { shown: string[]; more: number } {
  return { shown: names.slice(0, max), more: Math.max(0, names.length - max) }
}

/** A short, human error for a toast; strips Electron's "Error invoking remote method" wrapper. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const text = raw.replace(/^Error invoking remote method '[^']*': /, '').replace(/^Error: /, '')
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

/** Plain-text transcript for the clipboard: '[00:01:02] Name: text' per utterance. */
export function transcriptText(segments: MeetingSegment[], speakers: MeetingSpeaker[]): string {
  return orderedSegments(segments)
    .map((s) => `[${formatClock(s.start_ms)}] ${speakerLabel(s.speaker_key, speakers)}: ${s.text}`)
    .join('\n')
}
