import { useCallback, useEffect, useRef, useState, type UIEvent } from 'react'
import type { Stats, Transcript, TriggerKey } from '@shared/types'
import { formatDuration } from '@shared/format'
import { triggerLabel, defaultTriggerKey } from '@shared/trigger'
import { Flame, Clock, Type } from 'lucide-react'
import { api } from '../lib/api'
import { SearchBar } from '../components/SearchBar'
import { TranscriptRow } from '../components/TranscriptRow'
import type { Notify } from '../types'

const PAGE = 30

export function History({ notify }: { notify: Notify }): JSX.Element {
  const [items, setItems] = useState<Transcript[]>([])
  const [query, setQuery] = useState('')
  const [stats, setStats] = useState<Stats | null>(null)
  const [done, setDone] = useState(false)
  const [triggerKey, setTriggerKey] = useState<TriggerKey>(() => defaultTriggerKey(api.platform))
  const offset = useRef(0)
  const loading = useRef(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const loadStats = useCallback(async (): Promise<void> => {
    setStats(await api.history.stats())
  }, [])

  const reset = useCallback(async (q: string): Promise<void> => {
    loading.current = true
    const rows = q
      ? await api.history.search(q, { limit: PAGE, offset: 0 })
      : await api.history.list({ limit: PAGE, offset: 0 })
    setItems(rows)
    setDone(rows.length < PAGE)
    offset.current = rows.length
    loading.current = false
  }, [])

  const loadMore = useCallback(async (): Promise<void> => {
    if (loading.current || done) return
    loading.current = true
    const rows = query
      ? await api.history.search(query, { limit: PAGE, offset: offset.current })
      : await api.history.list({ limit: PAGE, offset: offset.current })
    setItems((cur) => [...cur, ...rows])
    setDone(rows.length < PAGE)
    offset.current += rows.length
    loading.current = false
  }, [query, done])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  useEffect(() => {
    void api.settings.get().then((s) => setTriggerKey(s.triggerKey))
    const off = api.onSettingsChanged((s) => setTriggerKey(s.triggerKey))
    return () => {
      off()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/') return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const id = setTimeout(() => void reset(query), 180)
    return () => clearTimeout(id)
  }, [query, reset])

  const onScroll = (e: UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 220) void loadMore()
  }

  const onCopy = async (id: number): Promise<void> => {
    await api.history.copy(id)
    notify('Copied to clipboard')
  }
  const onReinsert = async (id: number): Promise<void> => {
    await api.history.reinsert(id)
    notify('Re-inserted at cursor')
  }
  const onRetry = async (id: number): Promise<void> => {
    try {
      const updated = await api.history.retry(id)
      setItems((cur) => cur.map((t) => (t.id === id ? updated : t)))
      void loadStats()
      notify('Transcription retried')
    } catch (e) {
      notify(`Retry failed: ${(e as Error).message.slice(0, 60)}`)
    }
  }
  const onPolish = async (id: number): Promise<void> => {
    try {
      const updated = await api.history.polish(id)
      if (updated) setItems((cur) => cur.map((t) => (t.id === id ? updated : t)))
      notify('Cleaned up with Claude')
    } catch (e) {
      notify(`Cleanup failed: ${(e as Error).message.slice(0, 60)}`)
    }
  }
  const onDelete = async (id: number): Promise<void> => {
    await api.history.delete(id)
    setItems((cur) => cur.filter((t) => t.id !== id))
    void loadStats()
  }
  const onEdit = async (id: number, text: string): Promise<void> => {
    const { transcript, learned } = await api.history.edit(id, text)
    setItems((cur) => cur.map((t) => (t.id === id ? transcript : t)))
    void loadStats()
    if (learned.length) {
      const summary = learned.map((l) => `${l.from} → ${l.to}`).join(', ')
      notify(`Learned: ${summary}`, {
        label: 'Undo',
        onClick: () => void api.dictionary.undoLearn(learned)
      })
    } else {
      notify('Transcript updated')
    }
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-7 pt-6 pb-4 border-b border-border">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h1 className="text-lg font-semibold">History</h1>
          {stats && (
            <div className="flex items-center gap-4 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <Type className="w-3.5 h-3.5" />
                {stats.todayWords} words today
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                {formatDuration(stats.estSecondsSaved)} saved
              </span>
              <span className="flex items-center gap-1.5">
                <Flame className="w-3.5 h-3.5" />
                {stats.streakDays}-day streak
              </span>
            </div>
          )}
        </div>
        <SearchBar value={query} onChange={setQuery} inputRef={searchRef} />
      </header>

      <div className="flex-1 overflow-y-auto px-7 py-4" onScroll={onScroll}>
        {items.length === 0 ? (
          <Empty query={query} keyLabel={triggerLabel(triggerKey)} />
        ) : (
          <div className="flex flex-col gap-2.5 max-w-3xl mx-auto">
            {items.map((t) => (
              <TranscriptRow
                key={t.id}
                t={t}
                onCopy={onCopy}
                onReinsert={onReinsert}
                onRetry={onRetry}
                onPolish={onPolish}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
            {!done && <div className="text-center text-xs text-muted py-4">Loading more…</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function Empty({ query, keyLabel }: { query: string; keyLabel: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center text-muted gap-2 animate-fadeup">
      <div className="w-12 h-12 rounded-2xl bg-accent/10 text-accent flex items-center justify-center mb-1">
        <Type className="w-5 h-5" />
      </div>
      {query ? (
        <p className="text-sm">No transcripts match “{query}”.</p>
      ) : (
        <>
          <p className="text-sm text-text">No transcripts yet</p>
          <p className="text-xs">
            Hold{' '}
            <kbd className="px-1.5 py-0.5 rounded bg-surface2 border border-border text-text">{keyLabel}</kbd>{' '}
            anywhere and start talking.
          </p>
        </>
      )}
    </div>
  )
}
