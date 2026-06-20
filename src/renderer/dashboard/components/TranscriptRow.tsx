import { useState, type KeyboardEvent } from 'react'
import type { Transcript } from '@shared/types'
import { Copy, CornerDownLeft, Pencil, Sparkles, Trash2, Loader2, Play, type LucideIcon } from 'lucide-react'
import { api } from '../lib/api'

export function TranscriptRow({
  t,
  onCopy,
  onReinsert,
  onPolish,
  onEdit,
  onDelete
}: {
  t: Transcript
  onCopy: (id: number) => void
  onReinsert: (id: number) => void
  onPolish: (id: number) => Promise<void>
  onEdit: (id: number, text: string) => Promise<void>
  onDelete: (id: number) => void
}): JSX.Element {
  const [polishing, setPolishing] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const display = t.cleaned_text ?? t.raw_text ?? ''
  const time = new Date(t.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const handlePolish = async (): Promise<void> => {
    setPolishing(true)
    try {
      await onPolish(t.id)
    } finally {
      setPolishing(false)
    }
  }

  const startEdit = (): void => {
    setDraft(display)
    setEditing(true)
  }

  const saveEdit = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || text === display) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await onEdit(t.id, text)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  const onEditKeys = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') setEditing(false)
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void saveEdit()
  }

  const handlePlay = async (): Promise<void> => {
    if (playing) return
    const buf = await api.history.getAudio(t.id)
    if (!buf) return
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
    const audio = new Audio(url)
    const cleanup = (): void => {
      URL.revokeObjectURL(url)
      setPlaying(false)
    }
    audio.onended = cleanup
    audio.onerror = cleanup
    setPlaying(true)
    void audio.play()
  }

  return (
    <div className="group bg-surface border border-border rounded-xl p-4 hover:border-[#d4d7de] hover:shadow-card transition">
      <div className="flex items-center gap-2 text-xs text-muted mb-2 flex-wrap">
        <span>{time}</span>
        <span>·</span>
        <span className="truncate max-w-[180px]">{t.app_context}</span>
        <span>·</span>
        <span>
          {t.word_count} word{t.word_count === 1 ? '' : 's'}
        </span>
        {t.status === 'ok' && (
          <>
            <span>·</span>
            <span>{(t.latency_ms / 1000).toFixed(1)}s</span>
          </>
        )}
        {t.status === 'failed' && <span className="text-bad">· failed</span>}
        {t.status === 'empty' && <span>· no speech</span>}
        {t.cleaned_text && (
          <span className="px-1.5 py-0.5 rounded bg-accent/15 text-accent text-[10px] flex items-center gap-1">
            <Sparkles className="w-2.5 h-2.5" />
            cleaned
          </span>
        )}
      </div>

      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onEditKeys}
            autoFocus
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            className="w-full px-3 py-2 bg-bg border border-accent/40 rounded-lg text-sm leading-relaxed outline-none focus:border-accent/70 resize-y"
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={() => void saveEdit()}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent2 transition disabled:opacity-50"
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="px-3 py-1 rounded-md text-xs text-muted hover:text-text hover:bg-surface2 transition"
            >
              Cancel
            </button>
            <span className="text-[11px] text-muted ml-1">
              Fixed words are added to your dictionary automatically
            </span>
          </div>
        </div>
      ) : display ? (
        <p className="text-sm text-text/90 leading-relaxed whitespace-pre-wrap break-words">{display}</p>
      ) : (
        <p className="text-sm text-muted italic">No transcript text</p>
      )}

      {!editing && (
        <div className="flex items-center gap-1 mt-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition">
          {t.audio_path && (
            <RowBtn Icon={playing ? Loader2 : Play} spin={playing} label="Play" onClick={() => void handlePlay()} />
          )}
          <RowBtn Icon={Copy} label="Copy" onClick={() => onCopy(t.id)} />
          <RowBtn Icon={CornerDownLeft} label="Re-insert" onClick={() => onReinsert(t.id)} />
          <RowBtn Icon={Pencil} label="Edit" onClick={startEdit} disabled={t.status !== 'ok' || !display} />
          <RowBtn
            Icon={polishing ? Loader2 : Sparkles}
            spin={polishing}
            label={t.cleaned_text ? 'Re-polish' : 'Clean up'}
            onClick={handlePolish}
            disabled={!t.raw_text}
          />
          <RowBtn Icon={Trash2} label="Delete" danger onClick={() => onDelete(t.id)} />
        </div>
      )}
    </div>
  )
}

function RowBtn({
  Icon,
  label,
  onClick,
  danger,
  spin,
  disabled
}: {
  Icon: LucideIcon
  label: string
  onClick: () => void
  danger?: boolean
  spin?: boolean
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition disabled:opacity-30 disabled:cursor-not-allowed ${
        danger ? 'text-muted hover:text-bad hover:bg-bad/10' : 'text-muted hover:text-text hover:bg-surface2'
      }`}
    >
      <Icon className={`w-3.5 h-3.5 ${spin ? 'animate-spin' : ''}`} />
      {label}
    </button>
  )
}
