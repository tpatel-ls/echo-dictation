import { useCallback, useEffect, useRef, useState, type UIEvent } from 'react'
import type { HistoryQueryOpts, Stats, Transcript, TranscriptStatus, TriggerKey } from '@shared/types'
import { formatDuration } from '@shared/format'
import { triggerLabel, defaultTriggerKey } from '@shared/trigger'
import { Download, Flame, Clock, Trash2, Type } from 'lucide-react'
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
  const [status, setStatus] = useState<TranscriptStatus | 'all'>('all')
  const [dateRange, setDateRange] = useState<'all' | 'today' | '7d' | '30d'>('all')
  const [triggerKey, setTriggerKey] = useState<TriggerKey>(() => defaultTriggerKey(api.platform))
  const offset = useRef(0)
  const loading = useRef(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const requestOpts = useCallback((limit: number, requestOffset: number): HistoryQueryOpts => ({
    limit,
    offset: requestOffset,
    status: status === 'all' ? undefined : status,
    from: dateRangeStart(dateRange)
  }), [status, dateRange])

  const loadStats = useCallback(async (): Promise<void> => {
    setStats(await api.history.stats())
  }, [])

  const reset = useCallback(async (q: string): Promise<void> => {
    loading.current = true
    const rows = q
      ? await api.history.search(q, requestOpts(PAGE, 0))
      : await api.history.list(requestOpts(PAGE, 0))
    setItems(rows)
    setDone(rows.length < PAGE)
    offset.current = rows.length
    loading.current = false
  }, [requestOpts])

  const loadMore = useCallback(async (): Promise<void> => {
    if (loading.current || done) return
    loading.current = true
    const rows = query
      ? await api.history.search(query, requestOpts(PAGE, offset.current))
      : await api.history.list(requestOpts(PAGE, offset.current))
    setItems((cur) => [...cur, ...rows])
    setDone(rows.length < PAGE)
    offset.current += rows.length
    loading.current = false
  }, [query, done, requestOpts])

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
  const onExport = async (format: 'json' | 'csv'): Promise<void> => {
    const path = format === 'json' ? await api.history.exportJson() : await api.history.exportCsv()
    if (path) notify('Transcript history exported')
  }
  const onClearUnsuccessful = async (): Promise<void> => {
    const count = await api.history.clearUnsuccessful()
    if (count === null) return
    await reset(query)
    await loadStats()
    notify(count ? `Cleared ${count} unsuccessful attempt${count === 1 ? '' : 's'}` : 'Nothing to clear')
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-7 pt-6 pb-4 border-b border-border">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h1 className="text-lg font-semibold">History</h1>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => void onClearUnsuccessful()}
              title="Clear failed and empty attempts"
              aria-label="Clear failed and empty attempts"
              className="p-1.5 rounded-lg border border-border bg-surface text-muted hover:text-bad hover:bg-surface2 transition shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            {stats && <div className="flex items-center gap-4 text-xs text-muted">
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
            </div>}
            <div className="relative shrink-0">
              <Download className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <select
                aria-label="Export transcript history"
                value=""
                onChange={(event) => void onExport(event.target.value as 'json' | 'csv')}
                className="pl-7 pr-7 py-1.5 rounded-lg border border-border bg-surface text-xs font-medium hover:bg-surface2 transition appearance-none"
              >
                <option value="" disabled>Export</option>
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
              </select>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
          <SearchBar value={query} onChange={setQuery} inputRef={searchRef} />
          <select
            aria-label="Filter by transcript status"
            value={status}
            onChange={(event) => setStatus(event.target.value as TranscriptStatus | 'all')}
            className="px-2.5 py-2 bg-surface border border-border rounded-lg text-xs outline-none focus:border-accent/60"
          >
            <option value="all">All statuses</option>
            <option value="ok">Successful</option>
            <option value="failed">Failed</option>
            <option value="empty">Empty</option>
          </select>
          <select
            aria-label="Filter by transcript date"
            value={dateRange}
            onChange={(event) => setDateRange(event.target.value as typeof dateRange)}
            className="px-2.5 py-2 bg-surface border border-border rounded-lg text-xs outline-none focus:border-accent/60"
          >
            <option value="all">Any time</option>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-7 py-4" onScroll={onScroll}>
        {items.length === 0 ? (
          <Empty
            query={query}
            filtered={status !== 'all' || dateRange !== 'all'}
            keyLabel={triggerLabel(triggerKey)}
          />
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

function dateRangeStart(range: 'all' | 'today' | '7d' | '30d'): number | undefined {
  if (range === 'all') return undefined
  if (range === 'today') {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return today.getTime()
  }
  return Date.now() - (range === '7d' ? 7 : 30) * 86_400_000
}

function Empty({ query, filtered, keyLabel }: { query: string; filtered: boolean; keyLabel: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center text-muted gap-2 animate-fadeup">
      <div className="w-12 h-12 rounded-2xl bg-accent/10 text-accent flex items-center justify-center mb-1">
        <Type className="w-5 h-5" />
      </div>
      {query || filtered ? (
        <p className="text-sm">No transcripts match {query ? `“${query}”` : 'these filters'}.</p>
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
