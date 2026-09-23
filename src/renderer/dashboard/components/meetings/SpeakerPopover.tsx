import { useEffect, useRef, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { SELF_SPEAKER_KEY, type MeetingSpeaker, type Person } from '@shared/meeting-types'

/** Inline editor for one speaker's name: known people autocomplete, a one-click suggestion,
 * and "Remember this voice" so future meetings recognise them. */
export function SpeakerPopover({
  speakerKey,
  current,
  speaker,
  people,
  onSave,
  onClose
}: {
  speakerKey: string
  current: string
  speaker: MeetingSpeaker | undefined
  people: Person[]
  onSave: (name: string, remember: boolean) => Promise<void>
  onClose: () => void
}): JSX.Element {
  const isSelf = speakerKey === SELF_SPEAKER_KEY
  const [name, setName] = useState(speaker?.source === 'unknown' ? '' : current)
  const [remember, setRemember] = useState(!isSelf)
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  const query = name.trim().toLowerCase()
  const suggestion = speaker?.suggestion && speaker.suggestion !== name.trim() ? speaker.suggestion : null
  const matches = people
    .filter((p) => {
      const n = p.name.toLowerCase()
      return n !== query && n !== suggestion?.toLowerCase() && (!query || n.includes(query))
    })
    .slice(0, 5)

  const save = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      await onSave(trimmed, !isSelf && remember)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Name this speaker"
      className="absolute left-0 top-full mt-1 z-20 w-72 bg-surface border border-border rounded-xl shadow-panel p-3 animate-fadeup"
    >
      <label className="block text-xs text-muted mb-1.5">Who is this?</label>
      <input
        autoFocus
        value={name}
        placeholder="Name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
          if (e.key === 'Escape') onClose()
        }}
        className="w-full px-3 py-1.5 bg-bg border border-border rounded-lg text-sm outline-none focus:border-accent/60 placeholder:text-muted"
      />
      {(suggestion || matches.length > 0) && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {suggestion && (
            <button
              onClick={() => setName(suggestion)}
              title={speaker?.score != null ? `Voice match ${Math.round(speaker.score * 100)}%` : 'Suggested'}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/10 text-accent text-xs hover:bg-accent/15 transition"
            >
              <Sparkles className="w-3 h-3" />
              {suggestion}
            </button>
          )}
          {matches.map((p) => (
            <button
              key={p.id}
              onClick={() => setName(p.name)}
              className="px-2 py-0.5 rounded-full bg-surface2 text-xs text-text hover:bg-[#e3e6eb] transition max-w-full truncate"
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      {!isSelf && (
        <label className="flex items-center gap-2 mt-3 text-xs text-text cursor-pointer select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="accent-[#4f46e5]"
          />
          Remember this voice
        </label>
      )}
      <div className="flex items-center justify-end gap-2 mt-3">
        <button
          onClick={onClose}
          className="px-3 py-1 rounded-md text-xs text-muted hover:text-text hover:bg-surface2 transition"
        >
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={!name.trim() || saving}
          className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent2 active:scale-[0.98] transition disabled:opacity-50"
        >
          {saving && <Loader2 className="w-3 h-3 animate-spin" />}
          Save
        </button>
      </div>
    </div>
  )
}
