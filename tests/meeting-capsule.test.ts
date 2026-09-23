import { describe, it, expect } from 'vitest'
import { capsuleView, DETECTED_SETTLE_MS, NOTICE_SHOWN_MS, type CapsuleNotice } from '@shared/meeting-capsule'
import type { LiveMeetingState } from '@shared/meeting-types'

const IDLE: LiveMeetingState = {
  phase: 'idle',
  ended: null,
  recording: false,
  meetingId: null,
  app: null,
  title: null,
  startedAt: null,
  mic: 0,
  others: 0,
  micPaused: false
}
const live = (patch: Partial<LiveMeetingState>): LiveMeetingState => ({ ...IDLE, ...patch })
const notice = (shownAt: number | null): CapsuleNotice => ({ kind: 'notes-ready', meetingId: 7, shownAt })

describe('capsuleView', () => {
  it('is the plain idle capsule with nothing going on', () => {
    expect(capsuleView({ live: IDLE, detectedSince: null, hovered: false, notice: null, now: 0 })).toEqual({ kind: 'idle' })
  })

  it('shows a detected meeting expanded, then settles to a compact dot unless hovered', () => {
    const detected = live({ phase: 'detected', app: 'google-meet' })
    const at = (now: number, hovered = false) => capsuleView({ live: detected, detectedSince: 1000, hovered, notice: null, now })
    expect(at(1000)).toEqual({ kind: 'detected', compact: false })
    expect(at(1000 + DETECTED_SETTLE_MS - 1)).toEqual({ kind: 'detected', compact: false })
    expect(at(1000 + DETECTED_SETTLE_MS)).toEqual({ kind: 'detected', compact: true })
    expect(at(1000 + DETECTED_SETTLE_MS * 3, true)).toEqual({ kind: 'detected', compact: false })
  })

  it('shows recording and the saved or discarded ending', () => {
    expect(capsuleView({ live: live({ phase: 'recording', recording: true }), detectedSince: null, hovered: false, notice: null, now: 0 })).toEqual({ kind: 'recording' })
    expect(capsuleView({ live: live({ phase: 'ended', ended: 'saved' }), detectedSince: null, hovered: false, notice: null, now: 0 })).toEqual({
      kind: 'ended',
      outcome: 'saved'
    })
    expect(capsuleView({ live: live({ phase: 'ended', ended: 'discarded' }), detectedSince: null, hovered: false, notice: null, now: 0 })).toEqual({
      kind: 'ended',
      outcome: 'discarded'
    })
  })

  it('shows "Notes ready" for 5 s once it is first on screen', () => {
    // Not shown yet (a dictation was running): it starts counting when it appears.
    expect(capsuleView({ live: IDLE, detectedSince: null, hovered: false, notice: notice(null), now: 50_000 })).toEqual({
      kind: 'notice',
      notice: 'notes-ready',
      meetingId: 7
    })
    expect(capsuleView({ live: IDLE, detectedSince: null, hovered: false, notice: notice(1000), now: 1000 + NOTICE_SHOWN_MS - 1 }).kind).toBe('notice')
    expect(capsuleView({ live: IDLE, detectedSince: null, hovered: false, notice: notice(1000), now: 1000 + NOTICE_SHOWN_MS })).toEqual({ kind: 'idle' })
    // Hovering keeps it so it can be clicked.
    expect(capsuleView({ live: IDLE, detectedSince: null, hovered: true, notice: notice(1000), now: 1000 + NOTICE_SHOWN_MS * 2 }).kind).toBe('notice')
  })

  it('never lets a notice hide a live meeting', () => {
    expect(capsuleView({ live: live({ phase: 'recording', recording: true }), detectedSince: null, hovered: false, notice: notice(null), now: 0 }).kind).toBe('recording')
    expect(capsuleView({ live: live({ phase: 'detected' }), detectedSince: 0, hovered: false, notice: notice(null), now: 0 }).kind).toBe('detected')
    expect(capsuleView({ live: live({ phase: 'ended', ended: 'saved' }), detectedSince: null, hovered: false, notice: notice(null), now: 0 }).kind).toBe('notice')
  })
})
