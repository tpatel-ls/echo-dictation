import { useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { Person } from '@shared/meeting-types'
import { api } from '../../lib/api'
import { errorText } from '../../lib/meeting-view'
import type { Notify } from '../../types'

/** Remembered voices, collapsed by default. Forget deletes every stored exemplar of that person. */
export function PeoplePanel({ notify }: { notify: Notify }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [people, setPeople] = useState<Person[] | null>(null)
  const [confirm, setConfirm] = useState<number | null>(null)

  const load = async (): Promise<void> => {
    try {
      setPeople(await api.meetings.people())
    } catch (e) {
      setPeople([])
      notify(`Couldn't load remembered voices: ${errorText(e)}`)
    }
  }

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    setConfirm(null)
    if (next) void load()
  }

  const forget = async (person: Person): Promise<void> => {
    try {
      await api.meetings.forgetPerson(person.id)
      setPeople((cur) => (cur ?? []).filter((p) => p.id !== person.id))
      notify(`Forgot ${person.name}'s voice`)
    } catch (e) {
      notify(`Forget failed: ${errorText(e)}`)
    } finally {
      setConfirm(null)
    }
  }

  return (
    <div className="border-t border-border bg-surface">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-4 py-2.5 text-xs text-muted hover:text-text transition"
      >
        <ChevronRight className={`w-3.5 h-3.5 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
        Remembered voices
        {people && open && <span className="ml-auto tabular-nums">{people.length}</span>}
      </button>
      {open && (
        <div className="max-h-48 overflow-y-auto px-4 pb-3">
          {people === null ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted" />
          ) : people.length === 0 ? (
            <p className="text-xs text-muted leading-relaxed">
              None yet. Name a speaker in a transcript and keep "Remember this voice" on.
            </p>
          ) : (
            <ul className="flex flex-col">
              {people.map((p) => (
                <li key={p.id} className="flex items-center gap-2 py-1.5 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="text-text truncate" title={p.name}>{p.name}</div>
                    <div className="text-muted text-[11px]">
                      {p.exemplars} sample{p.exemplars === 1 ? '' : 's'} · {Math.round(p.seconds / 60) || '<1'} min
                    </div>
                  </div>
                  {confirm === p.id ? (
                    <span className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => void forget(p)}
                        className="px-1.5 py-0.5 rounded bg-bad text-white font-medium hover:bg-bad/90 transition"
                      >
                        Forget
                      </button>
                      <button
                        onClick={() => setConfirm(null)}
                        className="px-1.5 py-0.5 rounded text-muted hover:text-text hover:bg-surface2 transition"
                      >
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirm(p.id)}
                      className="px-1.5 py-0.5 rounded text-muted hover:text-bad hover:bg-bad/10 transition shrink-0"
                    >
                      Forget
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
