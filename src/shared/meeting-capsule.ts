// ─────────────────────────────────────────────────────────────────────────────
// Which meeting state the bottom overlay capsule shows when no dictation is running: a detected
// meeting (expanded at first, then settled to a compact dot), a recording, how the last recording
// ended, a short notice (notes ready or failed), or the plain idle capsule. Pure: the overlay feeds
// it the live state, what it knows about hover and timing, and the clock.
// ─────────────────────────────────────────────────────────────────────────────

import type { LiveMeetingState, MeetingNoticeKind } from './meeting-types'

/** A detected meeting shows its label this long, then settles to a compact amber dot. */
export const DETECTED_SETTLE_MS = 5000
/** A notice (notes ready or failed) shows this long once it is on screen. */
export const NOTICE_SHOWN_MS = 5000

export interface CapsuleNotice {
  kind: MeetingNoticeKind
  meetingId: number
  /** When it first appeared on screen; null while a dictation held it back. */
  shownAt: number | null
}

export type CapsuleView =
  | { kind: 'idle' }
  | { kind: 'detected'; compact: boolean }
  | { kind: 'recording' }
  | { kind: 'ended'; outcome: 'saved' | 'discarded' }
  | { kind: 'notice'; notice: MeetingNoticeKind; meetingId: number }

export function capsuleView(input: {
  live: LiveMeetingState
  detectedSince: number | null
  hovered: boolean
  notice: CapsuleNotice | null
  now: number
}): CapsuleView {
  const { live, detectedSince, hovered, notice, now } = input
  if (live.phase === 'recording') return { kind: 'recording' }
  if (live.phase === 'detected') {
    const settled = detectedSince !== null && now - detectedSince >= DETECTED_SETTLE_MS
    return { kind: 'detected', compact: settled && !hovered }
  }
  if (notice && (notice.shownAt === null || hovered || now - notice.shownAt < NOTICE_SHOWN_MS)) {
    return { kind: 'notice', notice: notice.kind, meetingId: notice.meetingId }
  }
  if (live.phase === 'ended' && live.ended) return { kind: 'ended', outcome: live.ended }
  return { kind: 'idle' }
}
