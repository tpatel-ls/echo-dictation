import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { DictionaryEntry } from '@shared/types'
import { BookOpen, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { api } from '../lib/api'
import type { Notify } from '../types'

export function Dictionary({ notify }: { notify: Notify }): JSX.Element {
  const [entries, setEntries] = useState<DictionaryEntry[]>([])
  const [word, setWord] = useState('')
  const [misheard, setMisheard] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setEntries(await api.dictionary.list())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const onAdd = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const w = word.trim()
    if (!w) return
    const aliases = misheard
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    try {
      const added = await api.dictionary.add(w, aliases)
      setWord('')
      setMisheard('')
      await load()
      notify(`Added “${added.word}” to your dictionary`)
    } catch (err) {
      notify(`Couldn't add: ${(err as Error).message.slice(0, 60)}`)
    }
  }

  const onDelete = async (entry: DictionaryEntry): Promise<void> => {
    await api.dictionary.remove(entry.id)
    await load()
    notify(`Removed “${entry.word}”`)
  }

  const onRemoveAlias = async (entry: DictionaryEntry, alias: string): Promise<void> => {
    await api.dictionary.update(entry.id, { misheard: entry.misheard.filter((a) => a !== alias) })
    await load()
  }

  const onAddAlias = async (entry: DictionaryEntry, alias: string): Promise<void> => {
    await api.dictionary.update(entry.id, { misheard: [...entry.misheard, alias] })
    await load()
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-7 pt-6 pb-4 border-b border-border">
        <div className="flex items-center justify-between gap-4 mb-1">
          <h1 className="text-lg font-semibold">Dictionary</h1>
          {entries.length > 0 && (
            <span className="text-xs text-muted">
              {entries.length} word{entries.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <p className="text-xs text-muted leading-relaxed max-w-xl">
          Echo prefers these spellings while transcribing and auto-fixes known mishearings.
          Corrections you make to transcripts in History are learned automatically.
        </p>
        <form onSubmit={(e) => void onAdd(e)} className="flex items-center gap-2 mt-4">
          <input
            value={word}
            onChange={(e) => setWord(e.target.value)}
            placeholder="Word — e.g. Bryan"
            className="w-48 px-3 py-2 bg-surface border border-border rounded-lg text-sm outline-none focus:border-accent/60 placeholder:text-muted"
          />
          <input
            value={misheard}
            onChange={(e) => setMisheard(e.target.value)}
            placeholder="Misheard as (optional, comma-separated) — e.g. Brian, Brain"
            className="flex-1 max-w-md px-3 py-2 bg-surface border border-border rounded-lg text-sm outline-none focus:border-accent/60 placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={!word.trim()}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent2 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        </form>
      </header>

      <div className="flex-1 overflow-y-auto px-7 py-4">
        {entries.length === 0 ? (
          <Empty />
        ) : (
          <div className="flex flex-col gap-2.5 max-w-3xl mx-auto">
            {entries.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                onDelete={() => void onDelete(e)}
                onRemoveAlias={(alias) => void onRemoveAlias(e, alias)}
                onAddAlias={(alias) => void onAddAlias(e, alias)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function EntryRow({
  entry,
  onDelete,
  onRemoveAlias,
  onAddAlias
}: {
  entry: DictionaryEntry
  onDelete: () => void
  onRemoveAlias: (alias: string) => void
  onAddAlias: (alias: string) => void
}): JSX.Element {
  const [alias, setAlias] = useState('')

  const submitAlias = (): void => {
    const a = alias.trim()
    if (!a) return
    onAddAlias(a)
    setAlias('')
  }

  const onAliasKeys = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submitAlias()
    }
  }

  return (
    <div className="group bg-surface border border-border rounded-xl px-4 py-3 hover:border-[#d4d7de] hover:shadow-card transition">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm font-semibold text-text">{entry.word}</span>
        {entry.source === 'learned' && (
          <span className="px-1.5 py-0.5 rounded bg-accent/15 text-accent text-[10px] flex items-center gap-1">
            <Sparkles className="w-2.5 h-2.5" />
            auto-learned
          </span>
        )}
        {entry.times_applied > 0 && (
          <span className="text-[11px] text-muted">
            fixed {entry.times_applied} time{entry.times_applied === 1 ? '' : 's'}
          </span>
        )}
        <button
          onClick={onDelete}
          title="Delete word"
          className="ml-auto p-1.5 rounded-md text-muted opacity-0 group-hover:opacity-100 hover:text-bad hover:bg-bad/10 transition"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        <span className="text-[11px] text-muted mr-0.5">misheard as</span>
        {entry.misheard.map((a) => (
          <span
            key={a}
            className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface2 border border-border text-xs text-text/80"
          >
            {a}
            <button
              onClick={() => onRemoveAlias(a)}
              title={`Stop replacing “${a}”`}
              className="text-muted hover:text-bad transition"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <input
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={onAliasKeys}
          onBlur={submitAlias}
          placeholder="+ add"
          className="w-20 px-2 py-0.5 bg-transparent border border-transparent hover:border-border focus:border-accent/60 rounded-full text-xs outline-none placeholder:text-muted/70 transition"
        />
      </div>
    </div>
  )
}

function Empty(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center text-muted gap-2">
      <div className="w-12 h-12 rounded-2xl bg-surface2 flex items-center justify-center mb-1">
        <BookOpen className="w-5 h-5" />
      </div>
      <p className="text-sm text-text">Teach Echo your words</p>
      <p className="text-xs max-w-sm leading-relaxed">
        Add names and jargon above, or just edit a transcript in History — when you fix a word
        there, Echo learns the correction and never makes that mistake again.
      </p>
    </div>
  )
}
