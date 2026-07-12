import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Pencil, Plus, TextQuote, Trash2, X } from 'lucide-react'
import type { StoredSnippet } from '@shared/snippets'
import { filterSnippets } from '@shared/snippet-search'
import { api } from '../lib/api'
import { SearchBar } from '../components/SearchBar'
import type { Notify } from '../types'

export function Snippets({ notify }: { notify: Notify }): JSX.Element {
  const [snippets, setSnippets] = useState<StoredSnippet[]>([])
  const [query, setQuery] = useState('')
  const [cue, setCue] = useState('')
  const [expansion, setExpansion] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)

  const load = useCallback(async (): Promise<void> => setSnippets(await api.snippets.list()), [])
  useEffect(() => { void load() }, [load])
  const visible = useMemo(() => filterSnippets(snippets, query), [snippets, query])

  const resetForm = (): void => {
    setCue('')
    setExpansion('')
    setEditingId(null)
  }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!cue.trim()) return
    if (editingId === null) await api.snippets.add(cue, expansion)
    else await api.snippets.update(editingId, { cue, expansion })
    resetForm()
    await load()
    notify(editingId === null ? 'Snippet added' : 'Snippet updated')
  }
  const edit = (snippet: StoredSnippet): void => {
    setEditingId(snippet.id)
    setCue(snippet.cue)
    setExpansion(snippet.expansion)
  }
  const remove = async (snippet: StoredSnippet): Promise<void> => {
    await api.snippets.remove(snippet.id)
    if (editingId === snippet.id) resetForm()
    await load()
    notify('Snippet removed')
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-7 pt-6 pb-4 border-b border-border">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h1 className="text-lg font-semibold">Snippets</h1>
          <span className="text-xs text-muted">{snippets.length} saved</span>
        </div>
        <SearchBar value={query} onChange={setQuery} />
        <form onSubmit={(event) => void save(event)} className="grid grid-cols-[180px_minmax(0,1fr)_auto_auto] gap-2 mt-3 items-start">
          <input
            value={cue}
            onChange={(event) => setCue(event.target.value)}
            placeholder="Spoken cue"
            className="px-3 py-2 bg-surface border border-border rounded-lg text-sm outline-none focus:border-accent/60"
          />
          <textarea
            value={expansion}
            onChange={(event) => setExpansion(event.target.value)}
            placeholder="Text to insert"
            rows={1}
            className="min-h-9 max-h-24 resize-y px-3 py-2 bg-surface border border-border rounded-lg text-sm outline-none focus:border-accent/60"
          />
          <button
            type="submit"
            disabled={!cue.trim()}
            className="h-9 px-3 rounded-lg bg-accent text-white text-sm font-medium flex items-center gap-1.5 disabled:opacity-40"
          >
            <Plus className="w-4 h-4" />
            {editingId === null ? 'Add' : 'Save'}
          </button>
          {editingId !== null && (
            <button type="button" onClick={resetForm} title="Cancel edit" aria-label="Cancel edit" className="h-9 w-9 rounded-lg border border-border bg-surface text-muted hover:text-text flex items-center justify-center">
              <X className="w-4 h-4" />
            </button>
          )}
        </form>
      </header>
      <div className="flex-1 overflow-y-auto px-7 py-4">
        {visible.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted gap-2">
            <TextQuote className="w-7 h-7" />
            <p className="text-sm">{query ? 'No snippets match your search' : 'No snippets yet'}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5 max-w-3xl mx-auto">
            {visible.map((snippet) => (
              <div key={snippet.id} className="group bg-surface border border-border rounded-lg px-4 py-3 flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{snippet.cue}</div>
                  <div className="text-xs text-muted mt-1 whitespace-pre-wrap break-words line-clamp-3">{snippet.expansion}</div>
                </div>
                <button type="button" onClick={() => edit(snippet)} title="Edit snippet" aria-label="Edit snippet" className="p-1.5 rounded-md text-muted hover:text-text hover:bg-surface2">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button type="button" onClick={() => void remove(snippet)} title="Delete snippet" aria-label="Delete snippet" className="p-1.5 rounded-md text-muted hover:text-bad hover:bg-bad/10">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
