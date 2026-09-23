import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileDown,
  FileText,
  FolderOpen,
  Loader2,
  RotateCcw,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import {
  MEETING_APP_LABELS,
  SELF_SPEAKER_KEY,
  type MeetingDetail as Detail,
  type MeetingNotes,
  type NoteItem,
  type Person
} from '@shared/meeting-types'
import { api } from '../../lib/api'
import {
  errorText,
  formatClock,
  formatMeetingLength,
  formatTime,
  orderedSegments,
  speakerColors,
  speakerLabel,
  transcriptText,
  utteranceIds
} from '../../lib/meeting-view'
import type { Notify } from '../../types'
import { SpeakerPopover } from './SpeakerPopover'

type Tab = 'notes' | 'transcript'

export function MeetingDetail({
  meeting,
  notify,
  onChanged,
  onDeleted
}: {
  meeting: Detail
  notify: Notify
  /** A fresh copy after a rename, or null to ask the page to reload this meeting. */
  onChanged: (detail: Detail | null) => void
  onDeleted: (id: number) => void
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('notes')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null)

  useEffect(() => {
    setTab(meeting.status === 'recording' ? 'transcript' : 'notes')
    setConfirmDelete(false)
    setFocus(null)
  }, [meeting.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const segments = useMemo(() => orderedSegments(meeting.segments), [meeting.segments])
  const participants = useMemo(() => {
    const byTime = [...meeting.speakers].sort((a, b) => b.seconds - a.seconds).map((s) => s.label)
    if (byTime.length) return byTime
    return [...new Set(segments.map((s) => speakerLabel(s.speaker_key, meeting.speakers)))]
  }, [meeting.speakers, segments])

  const working = meeting.status === 'recording' || meeting.status === 'processing'
  const title = meeting.title?.trim() || 'Untitled'
  const start = new Date(meeting.started_at)
  const length = formatMeetingLength(meeting.started_at, meeting.ended_at)

  const run = async (key: string, fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(key)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }

  const exportAs = (format: 'md' | 'txt'): Promise<void> =>
    run(`export-${format}`, async () => {
      try {
        const path = await api.meetings.exportFile(meeting.id, format)
        if (path) notify(`Saved ${format === 'md' ? 'Markdown' : 'text'} copy`)
      } catch (e) {
        notify(`Export failed: ${errorText(e)}`)
      }
    })

  const copyTranscript = (): Promise<void> =>
    run('copy', async () => {
      try {
        await navigator.clipboard.writeText(transcriptText(meeting.segments, meeting.speakers))
        notify('Transcript copied')
      } catch (e) {
        notify(`Copy failed: ${errorText(e)}`)
      }
    })

  const openFolder = (): Promise<void> =>
    run('folder', async () => {
      try {
        await api.meetings.openFolder(meeting.id)
      } catch (e) {
        notify(`Couldn't open the folder: ${errorText(e)}`)
      }
    })

  const reprocess = (): Promise<void> =>
    run('reprocess', async () => {
      try {
        await api.meetings.reprocess(meeting.id)
        notify('Reprocessing meeting')
        onChanged(null)
      } catch (e) {
        notify(`Reprocess failed: ${errorText(e)}`)
      }
    })

  const remove = (): Promise<void> =>
    run('delete', async () => {
      try {
        await api.meetings.remove(meeting.id)
        onDeleted(meeting.id)
        notify('Meeting deleted')
      } catch (e) {
        notify(`Delete failed: ${errorText(e)}`)
        setConfirmDelete(false)
      }
    })

  const cite = (id: string): void => {
    setTab('transcript')
    setFocus((cur) => ({ id, nonce: (cur?.nonce ?? 0) + 1 }))
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-6 pt-5 pb-3 border-b border-border">
        <h2 className="text-base font-semibold leading-snug break-words line-clamp-2" title={title}>
          {title}
        </h2>
        <div className="flex items-center gap-1.5 text-xs text-muted mt-1 flex-wrap">
          <span>{MEETING_APP_LABELS[meeting.app] ?? meeting.app}</span>
          <span>·</span>
          <span>{start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
          <span>·</span>
          <span>
            {formatTime(meeting.started_at)}
            {meeting.ended_at !== null && ` – ${formatTime(meeting.ended_at)}`}
          </span>
          {length && (
            <>
              <span>·</span>
              <span>{length}</span>
            </>
          )}
        </div>
        {participants.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {participants.map((name, i) => (
              <span
                key={`${name}-${i}`}
                className="px-2 py-0.5 rounded-full bg-surface2 text-[11px] text-text max-w-[220px] truncate"
                title={name}
              >
                {name}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1 mt-3 flex-wrap -ml-2">
          <Action Icon={FileDown} label="Download .md" busy={busy === 'export-md'} onClick={() => void exportAs('md')} disabled={meeting.status === 'recording'} />
          <Action Icon={FileText} label="Download .txt" busy={busy === 'export-txt'} onClick={() => void exportAs('txt')} disabled={meeting.status === 'recording'} />
          <Action Icon={Copy} label="Copy transcript" busy={busy === 'copy'} onClick={() => void copyTranscript()} disabled={!segments.length} />
          <Action Icon={FolderOpen} label="Open folder" busy={busy === 'folder'} onClick={() => void openFolder()} />
          <Action Icon={RotateCcw} label="Reprocess" busy={busy === 'reprocess'} onClick={() => void reprocess()} disabled={working} />
          {confirmDelete ? (
            <span className="flex items-center gap-1.5 ml-1 text-xs">
              <span className="text-bad">Delete this meeting?</span>
              <button
                onClick={() => void remove()}
                className="px-2 py-1 rounded-md bg-bad text-white font-medium hover:bg-bad/90 transition"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-1 rounded-md text-muted hover:text-text hover:bg-surface2 transition"
              >
                Cancel
              </button>
            </span>
          ) : (
            <Action Icon={Trash2} label="Delete" iconOnly danger onClick={() => setConfirmDelete(true)} disabled={meeting.status === 'recording'} />
          )}
        </div>
        <div role="tablist" className="flex gap-1 mt-3 -mb-3">
          {(['notes', 'transcript'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-sm border-b-2 transition ${
                tab === t ? 'border-accent text-accent font-medium' : 'border-transparent text-muted hover:text-text'
              }`}
            >
              {t === 'notes' ? 'Notes' : `Transcript${segments.length ? ` (${segments.length})` : ''}`}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        {tab === 'notes' ? (
          <NotesView meeting={meeting} onCite={cite} onReprocess={() => void reprocess()} reprocessing={busy === 'reprocess'} />
        ) : (
          <TranscriptView meeting={meeting} focus={focus} notify={notify} onChanged={onChanged} />
        )}
      </div>
    </div>
  )
}

function Action({
  Icon,
  label,
  onClick,
  busy = false,
  danger = false,
  disabled = false,
  iconOnly = false
}: {
  Icon: LucideIcon
  label: string
  onClick: () => void
  busy?: boolean
  danger?: boolean
  disabled?: boolean
  iconOnly?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      title={iconOnly ? label : undefined}
      aria-label={iconOnly ? label : undefined}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition disabled:opacity-40 disabled:cursor-not-allowed ${
        danger ? 'text-muted hover:text-bad hover:bg-bad/10' : 'text-muted hover:text-text hover:bg-surface2'
      }`}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
      {!iconOnly && label}
    </button>
  )
}

// ── Notes ─────────────────────────────────────────────────────────────────────

function NotesView({
  meeting,
  onCite,
  onReprocess,
  reprocessing
}: {
  meeting: Detail
  onCite: (id: string) => void
  onReprocess: () => void
  reprocessing: boolean
}): JSX.Element {
  if (meeting.status === 'recording') {
    return <Muted>Notes are written after the call ends. The live transcript is on the Transcript tab.</Muted>
  }
  if (meeting.status === 'processing') {
    return (
      <div aria-busy="true" className="max-w-2xl">
        <div className="flex items-center gap-2 text-sm text-muted mb-5">
          <Loader2 className="w-4 h-4 animate-spin text-accent" />
          {meeting.progress ?? 'Processing…'}
        </div>
        {[0, 1, 2].map((section) => (
          <div key={section} className="mb-6">
            <div className="h-3 w-24 rounded bg-surface2 mb-3 animate-pulse" />
            {[92, 78, 64].map((w) => (
              <div key={w} className="h-3 rounded bg-surface2 mb-2.5 animate-pulse" style={{ width: `${w - section * 8}%` }} />
            ))}
          </div>
        ))}
      </div>
    )
  }
  if (meeting.status === 'failed') {
    return (
      <div className="max-w-2xl bg-bad/5 border border-bad/20 rounded-xl p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-bad">
          <AlertTriangle className="w-4 h-4" />
          Processing failed
        </div>
        <p className="text-sm text-text/80 mt-1.5 break-words">{meeting.error ?? 'Unknown error'}</p>
        <button
          onClick={onReprocess}
          disabled={reprocessing}
          className="flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent2 active:scale-[0.98] transition disabled:opacity-50"
        >
          {reprocessing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
          Reprocess
        </button>
      </div>
    )
  }
  if (!meeting.notes) {
    return <Muted>No notes (AI notes are off or the AI proxy was unavailable)</Muted>
  }
  return <NotesBody notes={meeting.notes} onCite={onCite} />
}

function NotesBody({ notes, onCite }: { notes: MeetingNotes; onCite: (id: string) => void }): JSX.Element {
  const empty =
    !notes.summary.length && !notes.decisions.length && !notes.actionItems.length && !notes.openQuestions.length
  return (
    <div className="max-w-2xl flex flex-col gap-6">
      {empty && <Muted>The notes came back empty for this meeting.</Muted>}
      {notes.summary.length > 0 && (
        <NoteSection title="Summary">
          <ul className="flex flex-col gap-1.5">
            {notes.summary.map((line, i) => (
              <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
                <span className="mt-2 w-1 h-1 rounded-full bg-muted shrink-0" />
                <span className="min-w-0 break-words">{line}</span>
              </li>
            ))}
          </ul>
        </NoteSection>
      )}
      <ItemSection title="Decisions" items={notes.decisions} onCite={onCite} />
      <ItemSection title="Action items" items={notes.actionItems} onCite={onCite} checkbox />
      <ItemSection title="Open questions" items={notes.openQuestions} onCite={onCite} />
      <div className="text-[11px] text-muted border-t border-border pt-3">
        Drafted by {notes.model}
        {notes.verifiedBy ? ` · checked against the transcript by ${notes.verifiedBy}` : ' · not verified'}
      </div>
    </div>
  )
}

function NoteSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section>
      <h3 className="text-xs uppercase tracking-wider text-muted mb-2">{title}</h3>
      {children}
    </section>
  )
}

function ItemSection({
  title,
  items,
  onCite,
  checkbox = false
}: {
  title: string
  items: NoteItem[]
  onCite: (id: string) => void
  checkbox?: boolean
}): JSX.Element | null {
  if (!items.length) return null
  return (
    <NoteSection title={title}>
      <ul className="flex flex-col gap-2">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
            {checkbox ? (
              <span className="mt-[3px] w-3.5 h-3.5 rounded border border-[#c8ccd5] bg-surface shrink-0" />
            ) : (
              <span className="mt-2 w-1 h-1 rounded-full bg-muted shrink-0" />
            )}
            <div className="min-w-0">
              <span className="break-words">{item.text}</span>
              <div className="flex items-center gap-1.5 flex-wrap mt-1">
                {item.owner && <Chip>{item.owner}</Chip>}
                {item.due && <Chip>Due {item.due}</Chip>}
                <VerificationMark item={item} />
                {item.cites.map((c) => (
                  <button
                    key={c}
                    onClick={() => onCite(c)}
                    title="Show in transcript"
                    className="text-[11px] font-mono text-accent/80 hover:text-accent hover:underline"
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </NoteSection>
  )
}

function Chip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="px-1.5 py-0.5 rounded bg-surface2 text-[11px] text-text max-w-[200px] truncate">{children}</span>
  )
}

function VerificationMark({ item }: { item: NoteItem }): JSX.Element | null {
  if (item.verification === 'supported') {
    return (
      <span className="flex items-center gap-1 text-[11px] text-good" title={confidenceTitle(item)}>
        <CheckCircle2 className="w-3 h-3" />
        Verified against transcript
      </span>
    )
  }
  if (item.verification === 'insufficient') {
    return (
      <span className="flex items-center gap-1 text-[11px] text-warn" title={confidenceTitle(item)}>
        <AlertTriangle className="w-3 h-3" />
        Needs a check
      </span>
    )
  }
  return null
}

function confidenceTitle(item: NoteItem): string | undefined {
  return item.confidence != null ? `Confidence ${Math.round(item.confidence * 100)}%` : undefined
}

function Muted({ children }: { children: ReactNode }): JSX.Element {
  return <p className="text-sm text-muted max-w-2xl">{children}</p>
}

// ── Transcript ────────────────────────────────────────────────────────────────

function TranscriptView({
  meeting,
  focus,
  notify,
  onChanged
}: {
  meeting: Detail
  focus: { id: string; nonce: number } | null
  notify: Notify
  onChanged: (detail: Detail | null) => void
}): JSX.Element {
  const segments = useMemo(() => orderedSegments(meeting.segments), [meeting.segments])
  const ids = useMemo(() => utteranceIds(meeting.segments), [meeting.segments])
  const colors = useMemo(() => speakerColors(meeting.segments), [meeting.segments])
  const [editing, setEditing] = useState<number | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [highlight, setHighlight] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!focus) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-utterance="${focus.id}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setHighlight(focus.id)
    const timer = setTimeout(() => setHighlight(null), 2400)
    return () => clearTimeout(timer)
  }, [focus])

  const openEditor = (segmentId: number): void => {
    setEditing(segmentId)
    api.meetings.people().then(setPeople, () => setPeople([]))
  }

  const rename = async (key: string, name: string, remember: boolean): Promise<void> => {
    try {
      const updated = await api.meetings.renameSpeaker(meeting.id, key, name, remember)
      setEditing(null)
      onChanged(updated)
      notify(remember ? `Named ${name} and remembered their voice` : `Named ${name}`)
    } catch (e) {
      notify(`Rename failed: ${errorText(e)}`)
    }
  }

  if (!segments.length) {
    return (
      <p className="text-sm text-muted">
        {meeting.status === 'recording' ? 'Listening… the first lines appear within a few seconds.' : 'No transcript for this meeting.'}
      </p>
    )
  }

  return (
    <div ref={listRef} className="max-w-3xl flex flex-col">
      {segments.map((s, i) => {
        const key = s.speaker_key
        const self = key === SELF_SPEAKER_KEY
        const label = speakerLabel(key, meeting.speakers)
        const who = meeting.speakers.find((sp) => sp.key === key)
        const uid = ids.get(s.id) ?? ''
        const continued = i > 0 && segments[i - 1].speaker_key === key
        return (
          <div
            key={s.id}
            data-utterance={uid}
            className={`relative grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 px-2 rounded-lg transition-colors duration-500 ${
              continued ? 'py-0.5' : 'pt-2.5 pb-0.5'
            } ${highlight === uid ? 'bg-accent/10' : ''}`}
          >
            <span className="text-[11px] font-mono text-muted pt-[3px] tabular-nums" title={uid}>
              [{formatClock(s.start_ms)}]
            </span>
            <div className="min-w-0">
              {!continued && (
                <div className="relative">
                  <button
                    onClick={() => (editing === s.id ? setEditing(null) : openEditor(s.id))}
                    disabled={meeting.status === 'recording'}
                    title={meeting.status === 'recording' ? undefined : 'Rename speaker'}
                    className={`text-xs font-semibold mb-0.5 max-w-full truncate rounded disabled:cursor-default ${
                      self ? 'px-1.5 py-px bg-accent/10 text-accent' : 'hover:underline'
                    }`}
                    style={self ? undefined : { color: colors.get(key) }}
                  >
                    {label}
                    {self && label !== 'You' && <span className="font-normal opacity-70"> (you)</span>}
                    {who?.source === 'calendar' && <span className="font-normal text-muted"> · from calendar</span>}
                    {who?.source === 'unknown' && who.suggestion && <span className="font-normal text-muted"> ({who.suggestion}?)</span>}
                  </button>
                  {editing === s.id && (
                    <SpeakerPopover
                      speakerKey={key}
                      current={label}
                      speaker={meeting.speakers.find((sp) => sp.key === key)}
                      people={people}
                      onSave={(name, remember) => rename(key, name, remember)}
                      onClose={() => setEditing(null)}
                    />
                  )}
                </div>
              )}
              <p className={`text-sm leading-relaxed break-words ${self ? 'text-text' : 'text-text/90'}`}>{s.text}</p>
            </div>
          </div>
        )
      })}
      {meeting.status === 'recording' && (
        <div className="flex items-center gap-1.5 text-xs text-muted px-2 pt-3">
          <Check className="w-3 h-3" />
          Live transcript; the final pass replaces it after the call.
        </div>
      )}
    </div>
  )
}
