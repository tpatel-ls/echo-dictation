import type { LiveMeetingState } from '@shared/meeting-types'
import type { CapsuleNotice } from '@shared/meeting-capsule'

// The meeting state behind the overlay capsule, kept outside React so the dictation UI never
// re-renders for meeting updates (levels arrive several times a second) and so a notice that
// lands during a dictation waits for it to end. Subscribers are told only about changes the
// capsule shows.

export interface MeetingSnapshot {
  live: LiveMeetingState | null
  /** When the current detected meeting was first shown (it settles to a compact dot later). */
  detectedSince: number | null
  notice: CapsuleNotice | null
}

let snapshot: MeetingSnapshot = { live: null, detectedSince: null, notice: null }
const listeners = new Set<() => void>()
let started = false

function shown(live: LiveMeetingState | null): string {
  if (!live) return ''
  return [live.phase, live.ended, live.meetingId, live.app, live.title, live.startedAt, live.micPaused].join('|')
}

function set(next: MeetingSnapshot): void {
  snapshot = next
  for (const listener of [...listeners]) listener()
}

function applyLive(live: LiveMeetingState): void {
  if (shown(live) === shown(snapshot.live)) return
  const wasDetected = snapshot.live?.phase === 'detected'
  const detectedSince = live.phase === 'detected' ? (wasDetected ? snapshot.detectedSince : Date.now()) : null
  set({ ...snapshot, live, detectedSince })
}

function start(): void {
  if (started) return
  started = true
  window.api.meetings.onEvent((e) => {
    if (e.type === 'live') applyLive(e.state)
    if (e.type === 'notice') set({ ...snapshot, notice: { kind: e.kind, meetingId: e.meetingId, shownAt: null } })
  })
  window.api.meetings.live().then(applyLive, () => undefined)
}

export const meetingStore = {
  subscribe(listener: () => void): () => void {
    start()
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  get(): MeetingSnapshot {
    return snapshot
  },
  /** The notice is on screen now: its display time starts. */
  noticeShown(at: number): void {
    if (snapshot.notice && snapshot.notice.shownAt === null) set({ ...snapshot, notice: { ...snapshot.notice, shownAt: at } })
  },
  clearNotice(): void {
    if (snapshot.notice) set({ ...snapshot, notice: null })
  }
}
