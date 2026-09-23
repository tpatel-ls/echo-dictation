import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Mic, MicOff, Square, Trash2, Users } from 'lucide-react'
import {
  MEETING_APP_LABELS,
  type LiveMeetingState,
  type MeetingDetail as Detail,
  type MeetingSegment,
  type MeetingSpeaker,
  type MeetingSummary
} from '@shared/meeting-types'
import { api } from '../lib/api'
import {
  errorText,
  formatElapsed,
  formatMeetingLength,
  formatTime,
  groupByDay,
  orderedSegments,
  speakerLabel,
  visibleNames
} from '../lib/meeting-view'
import { MeetingDetail } from '../components/meetings/MeetingDetail'
import { PeoplePanel } from '../components/meetings/PeoplePanel'
import type { Notify } from '../types'

/** A request (from main, via App) to show a meeting; the nonce makes repeats re-apply. */
export interface MeetingFocus {
  meetingId: number | null
  nonce: number
}

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

export function Meetings({ notify, focus }: { notify: Notify; focus: MeetingFocus | null }): JSX.Element {
  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [live, setLive] = useState<LiveMeetingState>(IDLE)
  const [liveSegments, setLiveSegments] = useState<MeetingSegment[]>([])
  const selectedRef = useRef<number | null>(null)
  const liveIdRef = useRef<number | null>(null)
  selectedRef.current = selectedId

  const loadList = useCallback(async (): Promise<void> => {
    try {
      const rows = await api.meetings.list()
      setMeetings(rows)
      setSelectedId((cur) => (cur !== null && rows.some((m) => m.id === cur) ? cur : rows[0]?.id ?? null))
    } catch (e) {
      setMeetings((cur) => cur ?? [])
      notify(`Couldn't load meetings: ${errorText(e)}`)
    }
  }, [notify])

  const loadDetail = useCallback(async (id: number): Promise<void> => {
    try {
      const row = await api.meetings.get(id)
      if (selectedRef.current === id) setDetail(row)
    } catch (e) {
      notify(`Couldn't open the meeting: ${errorText(e)}`)
    }
  }, [notify])

  const applyLive = useCallback((state: LiveMeetingState): void => {
    setLive(state)
    const id = state.recording ? state.meetingId : null
    if (id === liveIdRef.current) return
    liveIdRef.current = id
    setLiveSegments([])
    if (id === null) return
    // Catch up on lines transcribed before this page opened.
    api.meetings.get(id).then(
      (row) => {
        if (row && liveIdRef.current === id) setLiveSegments(row.segments)
      },
      () => undefined
    )
  }, [])

  useEffect(() => {
    void loadList()
    api.meetings.live().then(applyLive, () => applyLive(IDLE))
    return api.meetings.onEvent((e) => {
      if (e.type === 'live') applyLive(e.state)
      if (e.type === 'segment') {
        if (e.meetingId === liveIdRef.current) setLiveSegments((cur) => [...cur, e.segment])
        if (e.meetingId === selectedRef.current) {
          setDetail((cur) => (cur && cur.id === e.meetingId ? { ...cur, segments: [...cur.segments, e.segment] } : cur))
        }
      }
      if (e.type === 'updated') {
        void loadList()
        if (e.meetingId === selectedRef.current) void loadDetail(e.meetingId)
      }
    })
  }, [loadList, loadDetail, applyLive])

  useEffect(() => {
    if (focus?.meetingId != null) setSelectedId(focus.meetingId)
  }, [focus])

  useEffect(() => {
    setDetail((cur) => (cur && cur.id === selectedId ? cur : null))
    if (selectedId !== null) void loadDetail(selectedId)
  }, [selectedId, loadDetail])

  const onChanged = (updated: Detail | null): void => {
    if (updated) setDetail(updated)
    else if (selectedId !== null) void loadDetail(selectedId)
    void loadList()
  }

  const onDeleted = (id: number): void => {
    const rows = (meetings ?? []).filter((m) => m.id !== id)
    setDetail(null)
    setMeetings(rows)
    setSelectedId(rows[0]?.id ?? null)
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-7 pt-6 pb-4 border-b border-border">
        <h1 className="text-lg font-semibold">Meetings</h1>
      </header>
      {live.phase === 'detected' && <DetectedBanner live={live} notify={notify} />}
      {live.recording && (
        <LiveBanner live={live} segments={liveSegments} speakers={detail?.id === live.meetingId ? detail.speakers : []} notify={notify} />
      )}
      <div className="flex-1 min-h-0 flex">
        {meetings === null ? (
          <div className="p-7 text-muted text-sm">Loading…</div>
        ) : meetings.length === 0 ? (
          <div className="flex-1 flex flex-col min-w-0">
            <Empty />
            <PeoplePanel notify={notify} />
          </div>
        ) : (
          <>
            <aside className="w-[300px] shrink-0 border-r border-border flex flex-col min-h-0 bg-surface/60">
              <div className="flex-1 overflow-y-auto py-2">
                {groupByDay(meetings).map((group) => (
                  <div key={group.label} className="mb-1">
                    <div className="px-4 pt-2 pb-1 text-[11px] uppercase tracking-wider text-muted">{group.label}</div>
                    {group.items.map((m) => (
                      <MeetingRow key={m.id} m={m} selected={m.id === selectedId} onSelect={() => setSelectedId(m.id)} />
                    ))}
                  </div>
                ))}
              </div>
              <PeoplePanel notify={notify} />
            </aside>
            <section className="flex-1 min-w-0 bg-surface">
              {detail ? (
                <MeetingDetail meeting={detail} notify={notify} onChanged={onChanged} onDeleted={onDeleted} />
              ) : (
                <div className="p-7 text-sm text-muted">{selectedId === null ? 'Select a meeting.' : 'Loading…'}</div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function MeetingRow({
  m,
  selected,
  onSelect
}: {
  m: MeetingSummary
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const { shown, more } = visibleNames(m.speakers)
  const length = formatMeetingLength(m.started_at, m.ended_at)
  return (
    <button
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`relative w-full text-left px-4 py-2.5 transition ${selected ? 'bg-accent/10' : 'hover:bg-surface2'}`}
    >
      {selected && <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent" />}
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span className="truncate">{MEETING_APP_LABELS[m.app] ?? m.app}</span>
        <span className="shrink-0">·</span>
        <span className="shrink-0 tabular-nums">{formatTime(m.started_at)}</span>
        {length && (
          <>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{length}</span>
          </>
        )}
        <span className="ml-auto shrink-0">
          <StatusBadge m={m} />
        </span>
      </div>
      <div className={`text-sm truncate mt-0.5 ${selected ? 'text-accent font-medium' : 'text-text'}`} title={m.title ?? undefined}>
        {m.title?.trim() || 'Untitled'}
      </div>
      {shown.length > 0 && (
        <div className="text-xs text-muted truncate mt-0.5">
          {shown.join(', ')}
          {more > 0 && ` +${more}`}
        </div>
      )}
      {m.status === 'processing' && m.progress && (
        <div className="text-[11px] text-accent truncate mt-0.5">{m.progress}</div>
      )}
    </button>
  )
}

function StatusBadge({ m }: { m: MeetingSummary }): JSX.Element | null {
  if (m.status === 'recording') {
    return (
      <span className="flex items-center gap-1 text-bad font-medium">
        <span className="w-1.5 h-1.5 rounded-full bg-bad echo-breathe" />
        Recording
      </span>
    )
  }
  if (m.status === 'processing') return <Loader2 aria-label="Processing" className="w-3 h-3 animate-spin text-accent" />
  if (m.status === 'failed') return <span className="px-1.5 py-px rounded bg-bad/10 text-bad font-medium">Failed</span>
  return null
}

/** A meeting was detected and waits for the call to begin (nothing is recorded yet). */
function DetectedBanner({ live, notify }: { live: LiveMeetingState; notify: Notify }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const act = async (label: string, fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      notify(`${label} failed: ${errorText(e)}`)
    } finally {
      setBusy(false)
    }
  }
  const app = live.app ? MEETING_APP_LABELS[live.app] : 'Meeting'
  return (
    <div className="border-b border-border bg-surface px-7 py-3 flex items-center gap-3">
      <span className="w-2.5 h-2.5 rounded-full bg-warn shrink-0" />
      <div className="min-w-0 flex-1 flex items-baseline gap-2">
        <span className="text-sm font-medium text-text shrink-0">Meeting detected · {app}</span>
        <span className="text-sm text-muted truncate">Starts when the call begins</span>
      </div>
      <button
        onClick={() => void act('Record now', () => api.meetings.startNow())}
        disabled={busy}
        className="px-3 py-1.5 rounded-lg bg-bad text-white text-xs font-medium hover:bg-bad/90 transition disabled:opacity-50 shrink-0"
      >
        Record now
      </button>
      <button
        onClick={() => void act("Don't record", () => api.meetings.stop())}
        disabled={busy}
        className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted hover:text-text hover:bg-surface2 transition disabled:opacity-50 shrink-0"
      >
        Don&apos;t record
      </button>
    </div>
  )
}

function LiveBanner({
  live,
  segments,
  speakers,
  notify
}: {
  live: LiveMeetingState
  segments: MeetingSegment[]
  speakers: MeetingSpeaker[]
  notify: Notify
}): JSX.Element {
  const [now, setNow] = useState(Date.now())
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState<'stop' | 'discard' | 'mic' | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [segments])

  const act = async (kind: 'stop' | 'discard'): Promise<void> => {
    if (busy) return
    setBusy(kind)
    try {
      await (kind === 'stop' ? api.meetings.stop() : api.meetings.discard())
      setConfirm(false)
    } catch (e) {
      notify(`${kind === 'stop' ? 'Stop' : 'Discard'} failed: ${errorText(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const toggleMic = async (): Promise<void> => {
    if (busy) return
    setBusy('mic')
    try {
      await api.meetings.setMicPaused(!live.micPaused)
    } catch (e) {
      notify(`Couldn't ${live.micPaused ? 'resume' : 'pause'} your mic: ${errorText(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const app = live.app ? MEETING_APP_LABELS[live.app] : 'Meeting'
  const lines = orderedSegments(segments)
  return (
    <div className="border-b border-border bg-surface">
      <div className="px-7 py-3 flex items-center gap-3">
        <span className="relative flex w-2.5 h-2.5 shrink-0">
          <span className="w-2.5 h-2.5 rounded-full bg-bad echo-breathe" />
        </span>
        <div className="min-w-0 flex-1 flex items-baseline gap-2">
          <span className="text-sm font-medium text-text shrink-0">Transcribing {app}</span>
          {live.title && <span className="text-sm text-muted truncate" title={live.title}>{live.title}</span>}
        </div>
        <button
          onClick={() => void toggleMic()}
          disabled={busy !== null}
          aria-pressed={live.micPaused}
          title={live.micPaused ? 'Silence is recorded in place of your mic. Click to resume.' : 'Click to record silence in place of your mic.'}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium shrink-0 transition disabled:opacity-50 ${
            live.micPaused ? 'bg-warn/15 text-warn hover:bg-warn/25' : 'text-muted hover:text-text hover:bg-surface2'
          }`}
        >
          {live.micPaused ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
          {live.micPaused ? 'Your mic: paused' : 'Your mic: on'}
        </button>
        <span className="text-sm font-mono tabular-nums text-text shrink-0">
          {live.startedAt ? formatElapsed(now - live.startedAt) : '00:00'}
        </span>
        {confirm ? (
          <span className="flex items-center gap-1.5 text-xs shrink-0">
            <span className="text-bad">Discard this recording?</span>
            <button
              onClick={() => void act('discard')}
              disabled={busy !== null}
              className="px-2.5 py-1 rounded-md bg-bad text-white font-medium hover:bg-bad/90 transition disabled:opacity-50"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirm(false)}
              className="px-2.5 py-1 rounded-md text-muted hover:text-text hover:bg-surface2 transition"
            >
              Cancel
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => void act('stop')}
              disabled={busy !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent2 active:scale-[0.98] transition disabled:opacity-50"
            >
              {busy === 'stop' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3 fill-current" />}
              Stop
            </button>
            <button
              onClick={() => setConfirm(true)}
              disabled={busy !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs text-muted hover:text-bad hover:bg-bad/5 transition disabled:opacity-50"
            >
              <Trash2 className="w-3 h-3" />
              Discard
            </button>
          </span>
        )}
      </div>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className="max-h-28 overflow-y-auto px-7 pb-3"
      >
        {lines.length === 0 ? (
          <p className="text-xs text-muted">Listening… the first lines appear within a few seconds.</p>
        ) : (
          lines.map((s) => (
            <p key={s.id} className="text-xs leading-relaxed text-text/85 break-words">
              <span className="font-medium text-muted">{speakerLabel(s.speaker_key, speakers)}: </span>
              {s.text}
            </p>
          ))
        )}
      </div>
    </div>
  )
}

function Empty(): JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 px-10 animate-fadeup">
      <div className="w-12 h-12 rounded-2xl bg-accent/10 text-accent flex items-center justify-center mb-1">
        <Users className="w-5 h-5" />
      </div>
      <p className="text-sm text-text">No meetings yet</p>
      <p className="text-xs text-muted max-w-md leading-relaxed">
        Echo transcribes Google Meet, Microsoft Teams, Slack huddles and Zoom automatically, only while a call
        is on. Audio stays on this PC and your GB10, and a small pill at the top of the screen shows whenever
        Echo is recording.
      </p>
    </div>
  )
}
