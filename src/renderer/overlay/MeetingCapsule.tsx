import { useEffect, useRef, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode } from 'react'
import { Check, ExternalLink, MicOff } from 'lucide-react'
import { MEETING_APP_LABELS } from '@shared/meeting-types'
import { capsuleView } from '@shared/meeting-capsule'
import { errorText, formatElapsed } from '../dashboard/lib/meeting-view'
import { meetingStore } from './meeting-store'

const api = window.api

/** Short app names for the capsule ("Meet", not "Google Meet"). */
const SHORT_APP: Record<string, string> = {
  'google-meet': 'Meet',
  teams: 'Teams',
  slack: 'Slack',
  zoom: 'Zoom',
  webex: 'Webex'
}

export interface CapsuleParts {
  className: string
  attrs: HTMLAttributes<HTMLDivElement>
  content: ReactNode
}

/**
 * The idle capsule and the meeting states it grows into while no dictation runs (`enabled`):
 * detected, recording, ended, and notes ready. It returns the class, handlers and content for the
 * overlay's single pill element, so the pill still morphs smoothly into a dictation. Hovering
 * expands it to reveal controls; while the pointer is over it the overlay takes clicks (it is
 * click-through otherwise and never takes focus).
 */
export function useMeetingCapsule(enabled: boolean): CapsuleParts {
  const snap = useSyncExternalStore(meetingStore.subscribe, meetingStore.get)
  const [now, setNow] = useState(Date.now())
  const [hovered, setHovered] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const interactive = useRef(false)

  const live = snap.live
  const view =
    enabled && live
      ? capsuleView({ live, detectedSince: snap.detectedSince, hovered, notice: snap.notice, now })
      : ({ kind: 'idle' } as const)

  useEffect(() => {
    if (!enabled || view.kind === 'idle') return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [enabled, view.kind])

  // A notice starts its display time once it is actually on screen (after any dictation).
  useEffect(() => {
    if (view.kind === 'notice') meetingStore.noticeShown(Date.now())
    else if (enabled && snap.notice !== null && snap.notice.shownAt !== null && view.kind === 'idle') meetingStore.clearNotice()
  }, [enabled, view.kind, snap.notice])

  useEffect(() => {
    if (view.kind !== 'recording') setConfirm(false)
  }, [view.kind])

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 3000)
    return () => clearTimeout(t)
  }, [error])

  const setInteractive = (on: boolean): void => {
    if (interactive.current === on) return
    interactive.current = on
    api.setOverlayInteractive(on)
  }
  // Click-through again whenever the capsule goes away (a dictation starts, the state ends).
  useEffect(() => () => setInteractive(false), [])
  useEffect(() => {
    if (view.kind === 'idle' || view.kind === 'ended') {
      setHovered(false)
      setInteractive(false)
    }
  }, [view.kind])

  const act = async (label: string, fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      setConfirm(false)
    } catch (e) {
      setError(`${label} failed: ${errorText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const hover = {
    onMouseEnter: () => {
      setHovered(true)
      setInteractive(true)
    },
    onMouseLeave: () => {
      setHovered(false)
      setConfirm(false)
      setInteractive(false)
    }
  }

  if (view.kind === 'idle') return { className: 'ov-idle', attrs: {}, content: null }

  const app = live?.app ? SHORT_APP[live.app] ?? MEETING_APP_LABELS[live.app] : 'Meeting'
  const fullApp = live?.app ? MEETING_APP_LABELS[live.app] : 'Meeting'

  if (view.kind === 'detected') {
    return {
      className: `ov-mt ov-mt-detected${view.compact ? ' ov-mt-compact' : ''}${hovered ? ' ov-mt-open' : ''}`,
      attrs: { ...hover, 'aria-label': `Meeting detected: ${fullApp}. Starts when the call begins.` },
      content: (
      <>
        <span className="ov-mt-dot ov-mt-dot-amber" />
        {!view.compact && (
          <span className="ov-mt-text" title="Recording starts when the call begins">
            Meeting detected · {app}
          </span>
        )}
        {hovered && (
          <span className="ov-mt-actions">
            {error ? (
              <span className="ov-mt-error">{error}</span>
            ) : (
              <>
                <button className="ov-mt-btn ov-mt-btn-rec" disabled={busy} onClick={() => void act('Record now', () => api.meetings.startNow())}>
                  Record now
                </button>
                <button className="ov-mt-btn" disabled={busy} onClick={() => void act("Don't record", () => api.meetings.stop())}>
                  Don&apos;t record
                </button>
              </>
            )}
          </span>
        )}
      </>
      )
    }
  }

  if (view.kind === 'recording' && live) {
    const elapsed = live.startedAt ? formatElapsed(now - live.startedAt) : '00:00'
    return {
      className: `ov-mt ov-mt-recording${hovered ? ' ov-mt-open' : ''}`,
      attrs: { ...hover, 'aria-label': `Recording ${fullApp}, ${elapsed}${live.micPaused ? ', your mic is paused' : ''}` },
      content: (
      <>
        <span className="ov-mt-dot ov-mt-dot-red" />
        <span className="ov-mt-time">{elapsed}</span>
        {live.micPaused && <MicOff className="ov-mt-micoff" aria-label="Your mic is paused" />}
        {hovered && (
          <>
            <span className="ov-mt-text ov-mt-title" title={live.title ? `${fullApp} · ${live.title}` : fullApp}>
              {live.title ? `${app} · ${live.title}` : app}
            </span>
            <span className="ov-mt-actions">
              {error ? (
                <span className="ov-mt-error">{error}</span>
              ) : confirm ? (
                <>
                  <span className="ov-mt-confirm">Discard?</span>
                  <button className="ov-mt-btn ov-mt-btn-rec" disabled={busy} onClick={() => void act('Discard', () => api.meetings.discard())}>
                    Discard
                  </button>
                  <button className="ov-mt-btn" onClick={() => setConfirm(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <>
                  <button
                    className={`ov-mt-btn${live.micPaused ? ' ov-mt-btn-on' : ''}`}
                    disabled={busy}
                    aria-pressed={live.micPaused}
                    onClick={() => void act(live.micPaused ? 'Resume' : 'Pause', () => api.meetings.setMicPaused(!live.micPaused))}
                  >
                    {live.micPaused ? 'Resume mic' : 'Pause my mic'}
                  </button>
                  <button className="ov-mt-btn" disabled={busy} onClick={() => void act('Stop', () => api.meetings.stop())}>
                    Stop
                  </button>
                  <button className="ov-mt-btn" disabled={busy} onClick={() => setConfirm(true)}>
                    Discard
                  </button>
                  <button
                    className="ov-mt-icon"
                    title="Open in Echo"
                    aria-label="Open in Echo"
                    onClick={() => void act('Open', () => api.meetings.show(live.meetingId))}
                  >
                    <ExternalLink />
                  </button>
                </>
              )}
            </span>
          </>
        )}
      </>
      )
    }
  }

  if (view.kind === 'ended') {
    const saved = view.outcome === 'saved'
    return {
      className: 'ov-mt ov-mt-ended',
      attrs: {},
      content: (
        <>
          {saved && <Check className="ov-mt-check" aria-hidden="true" />}
          <span className="ov-mt-text">{saved ? 'Saved · writing notes' : 'Discarded'}</span>
        </>
      )
    }
  }

  // Notice: notes ready (click to open), or what went wrong.
  const notice = view.kind === 'notice' ? view : null
  const ready = notice?.notice === 'notes-ready'
  const label = ready ? 'Notes ready' : notice?.notice === 'record-failed' ? "Couldn't record the meeting" : "Couldn't finish the notes"
  return {
    className: `ov-mt ov-mt-notice${ready ? '' : ' ov-mt-notice-warn'}`,
    attrs: hover,
    content: (
      <button
        className="ov-mt-notice-btn"
        onClick={() => {
          if (notice) void api.meetings.show(notice.meetingId)
          meetingStore.clearNotice()
        }}
      >
        {ready && <Check className="ov-mt-check" aria-hidden="true" />}
        <span className="ov-mt-text">{label}</span>
        <ExternalLink className="ov-mt-open-icon" aria-hidden="true" />
      </button>
    )
  }
}
