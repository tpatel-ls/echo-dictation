import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import path from 'node:path'
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js'
import { HistoryStore } from '../src/main/store/history'
import { DictionaryStore } from '../src/main/store/dictionary'
import { SyncStore } from '../src/server/sync-store'
import { handleSyncRequest } from '../src/server/http'
import { SyncTable, SYNC_COLUMNS } from '../src/main/sync/sync-table'
import { SyncClient, MemorySyncState } from '../src/main/sync/client'
import { monotonicClock } from '../src/main/store/clock'
import type { NewTranscript } from '@shared/types'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})

afterEach(() => vi.useRealTimers())

function base(overrides: Partial<NewTranscript> = {}): NewTranscript {
  return {
    created_at: 1000,
    raw_text: 'hello world',
    cleaned_text: null,
    duration_ms: 1200,
    word_count: 2,
    latency_ms: 300,
    app_context: 'Code.exe',
    model: 'whisper-1',
    status: 'ok',
    audio_path: null,
    ...overrides
  }
}

/** A fetch bound to the REAL server handler over an in-memory store — a faithful loopback. */
function serverFetch(store: SyncStore, token: string): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' ? input : input.toString())
    const m = u.pathname.match(/^\/sync\/([^/]+)$/)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const auth = headers.Authorization ?? headers.authorization ?? ''
    const out = handleSyncRequest(store, token, {
      method: init?.method ?? 'GET',
      collection: m ? m[1] : null,
      since: Number(u.searchParams.get('since') ?? '0'),
      limit: Number(u.searchParams.get('limit') ?? 'NaN'),
      authToken: auth.startsWith('Bearer ') ? auth.slice(7) : null,
      body: init?.body ? JSON.parse(init.body as string) : null,
      isHealth: u.pathname === '/health'
    })
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => out.body
    }
  }) as unknown as typeof fetch
}

interface Device {
  db: Database
  history: HistoryStore
  dict: DictionaryStore
}

/** A device DB with both tables + stores; a fixed clock keeps updated_at deterministic. */
function device(now: () => number = () => Date.now()): Device {
  const db = new SQL.Database()
  return { db, history: new HistoryStore(db, () => {}, now), dict: new DictionaryStore(db, () => {}, now) }
}

function client(db: Database, fetch: typeof globalThis.fetch, state = new MemorySyncState()): SyncClient {
  return new SyncClient(
    [
      { name: 'transcripts', table: new SyncTable(db, 'transcripts', [...SYNC_COLUMNS.transcripts]) },
      { name: 'dictionary', table: new SyncTable(db, 'dictionary', [...SYNC_COLUMNS.dictionary]) }
    ],
    { baseUrl: 'http://sync', token: 'tok' },
    state,
    { fetch }
  )
}

describe('SyncClient', () => {
  it('syncs a transcript from device A to device B through the server', async () => {
    const fetch = serverFetch(new SyncStore(new SQL.Database()), 'tok')
    const a = device(() => 1000)
    a.history.insert(base({ raw_text: 'hello from A' }))
    await client(a.db, fetch).syncOnce()

    const b = device()
    await client(b.db, fetch).syncOnce()
    expect(b.history.list({ limit: 10, offset: 0 }).map((r) => r.raw_text)).toContain('hello from A')
  })

  it('syncs a dictionary entry (with aliases) from A to B', async () => {
    const fetch = serverFetch(new SyncStore(new SQL.Database()), 'tok')
    const a = device(() => 1000)
    a.dict.add('Bryan', ['Brian'], 'manual')
    await client(a.db, fetch).syncOnce()

    const b = device()
    await client(b.db, fetch).syncOnce()
    const onB = b.dict.list()
    expect(onB.map((e) => e.word)).toEqual(['Bryan'])
    expect(onB[0].misheard).toEqual(['Brian'])
  })

  it('reconciles bidirectionally: A and B each end with both rows', async () => {
    const fetch = serverFetch(new SyncStore(new SQL.Database()), 'tok')
    const a = device(() => 1000)
    a.history.insert(base({ raw_text: 'from A' }))
    const b = device(() => 2000)
    b.history.insert(base({ raw_text: 'from B' }))
    const ca = client(a.db, fetch)
    const cb = client(b.db, fetch)
    await ca.syncOnce() // A pushes "from A"
    await cb.syncOnce() // B pulls "from A", pushes "from B"
    await ca.syncOnce() // A pulls "from B"
    const onA = a.history.list({ limit: 10, offset: 0 }).map((r) => r.raw_text)
    const onB = b.history.list({ limit: 10, offset: 0 }).map((r) => r.raw_text)
    expect(onA.sort()).toEqual(['from A', 'from B'])
    expect(onB.sort()).toEqual(['from A', 'from B'])
  })

  it('propagates a soft-delete from A to B', async () => {
    const fetch = serverFetch(new SyncStore(new SQL.Database()), 'tok')
    let clockA = 1000
    const a = device(() => (clockA += 1000))
    const ca = client(a.db, fetch)
    const b = device()
    const cb = client(b.db, fetch)

    const t = a.history.insert(base({ raw_text: 'temp' }))
    await ca.syncOnce()
    await cb.syncOnce()
    expect(b.history.list({ limit: 10, offset: 0 })).toHaveLength(1)

    a.history.delete(t.id)
    await ca.syncOnce() // push the tombstone
    await cb.syncOnce() // pull it
    expect(b.history.list({ limit: 10, offset: 0 })).toHaveLength(0)
  })

  it('is idempotent: re-syncing creates no duplicates', async () => {
    const fetch = serverFetch(new SyncStore(new SQL.Database()), 'tok')
    const a = device(() => 1000)
    a.history.insert(base({ raw_text: 'once' }))
    const ca = client(a.db, fetch)
    await ca.syncOnce()
    await ca.syncOnce()

    const b = device()
    const cb = client(b.db, fetch)
    await cb.syncOnce()
    await cb.syncOnce()
    expect(b.history.list({ limit: 10, offset: 0 })).toHaveLength(1)
  })

  it('throws a SyncError on an auth failure', async () => {
    const fetch = serverFetch(new SyncStore(new SQL.Database()), 'right-token')
    const a = device()
    a.history.insert(base())
    const bad = new SyncClient(
      [{ name: 'transcripts', table: new SyncTable(a.db, 'transcripts', [...SYNC_COLUMNS.transcripts]) }],
      { baseUrl: 'http://sync', token: 'WRONG' },
      new MemorySyncState(),
      { fetch }
    )
    await expect(bad.syncOnce()).rejects.toThrow(/failed/)
  })

  it('skips a malformed remote record instead of wedging the collection', async () => {
    const server = new SyncStore(new SQL.Database())
    const fetch = serverFetch(server, 'tok')
    // A peer pushed a transcript whose payload is missing the NOT NULL raw_text column...
    server.upsert('transcripts', {
      uuid: 'bad',
      updatedAt: 100,
      deleted: false,
      payload: JSON.stringify({
        created_at: 1,
        duration_ms: 1,
        word_count: 1,
        latency_ms: 1,
        app_context: 'x',
        model: 'm',
        status: 'ok'
      })
    })
    // ...followed by a well-formed one.
    server.upsert('transcripts', {
      uuid: 'good',
      updatedAt: 200,
      deleted: false,
      payload: JSON.stringify({
        created_at: 2,
        raw_text: 'fine',
        cleaned_text: null,
        duration_ms: 1,
        word_count: 1,
        latency_ms: 1,
        app_context: 'x',
        model: 'm',
        status: 'ok'
      })
    })
    const b = device()
    await expect(client(b.db, fetch).syncOnce()).resolves.toBeUndefined()
    expect(b.history.list({ limit: 10, offset: 0 }).map((r) => r.raw_text)).toEqual(['fine'])
  })

  it('does not strand a row written in the same millisecond as a prior push', async () => {
    const fetch = serverFetch(new SyncStore(new SQL.Database()), 'tok')
    const clk = monotonicClock(() => 1000) // every write "happens" at ms 1000
    const db = new SQL.Database()
    const history = new HistoryStore(db, () => {}, clk)
    new DictionaryStore(db, () => {}, clk) // ensure the dictionary table exists for the client
    const ca = client(db, fetch)
    history.insert(base({ raw_text: 'first' })) // updated_at 1000
    await ca.syncOnce() // pushes "first", watermark → 1000
    history.insert(base({ raw_text: 'second' })) // updated_at 1001 (monotonic, not a 1000 tie)
    await ca.syncOnce() // 1001 > 1000 → "second" is pushed, not stranded

    const b = device()
    await client(b.db, fetch).syncOnce()
    expect(
      b.history
        .list({ limit: 10, offset: 0 })
        .map((r) => r.raw_text)
        .sort()
    ).toEqual(['first', 'second'])
  })

  it('aborts a sync request after its configured timeout', async () => {
    vi.useFakeTimers()
    const hangingFetch = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))
    const db = device().db
    const sync = new SyncClient(
      [{ name: 'transcripts', table: new SyncTable(db, 'transcripts', [...SYNC_COLUMNS.transcripts]) }],
      { baseUrl: 'http://sync', token: 'tok', timeoutMs: 5_000, retryCount: 0 },
      new MemorySyncState(),
      { fetch: hangingFetch as unknown as typeof fetch }
    )

    const pending = sync.syncOnce()
    const rejection = expect(pending).rejects.toThrow(/timed out after 5000ms/)
    await vi.advanceTimersByTimeAsync(5_000)

    await rejection
    expect((hangingFetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
  })

  it('honors caller cancellation immediately', async () => {
    const hangingFetch = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))
    const db = device().db
    const sync = new SyncClient(
      [{ name: 'transcripts', table: new SyncTable(db, 'transcripts', [...SYNC_COLUMNS.transcripts]) }],
      { baseUrl: 'http://sync', token: 'tok' },
      new MemorySyncState(),
      { fetch: hangingFetch as unknown as typeof fetch }
    )
    const controller = new AbortController()

    const pending = sync.syncOnce(controller.signal)
    controller.abort()

    await expect(pending).rejects.toThrow(/cancelled/)
  })

  it('retries transient server failures with bounded exponential backoff', async () => {
    const delays: number[] = []
    const responses = [503, 502, 200]
    const retryingFetch = vi.fn(async () => {
      const status = responses.shift() ?? 500
      return {
        ok: status === 200,
        status,
        json: async () => ({ records: [], cursor: 0, hasMore: false })
      } as Response
    })
    const db = device().db
    const sync = new SyncClient(
      [{ name: 'transcripts', table: new SyncTable(db, 'transcripts', [...SYNC_COLUMNS.transcripts]) }],
      { baseUrl: 'http://sync', token: 'tok', retryCount: 2, retryBaseMs: 100 },
      new MemorySyncState(),
      { fetch: retryingFetch as unknown as typeof fetch, delay: async (ms) => { delays.push(ms) } }
    )

    await expect(sync.syncOnce()).resolves.toBeUndefined()
    expect(retryingFetch).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([100, 200])
  })

  it('does not retry client errors and never exceeds the configured retry count', async () => {
    const db = device().db
    const unauthorized = vi.fn(async () => ({ ok: false, status: 401 }) as Response)
    const noRetry = new SyncClient(
      [{ name: 'transcripts', table: new SyncTable(db, 'transcripts', [...SYNC_COLUMNS.transcripts]) }],
      { baseUrl: 'http://sync', token: 'bad', retryCount: 3 },
      new MemorySyncState(),
      { fetch: unauthorized as unknown as typeof fetch, delay: async () => {} }
    )
    await expect(noRetry.syncOnce()).rejects.toThrow(/401/)
    expect(unauthorized).toHaveBeenCalledTimes(1)

    const unavailable = vi.fn(async () => ({ ok: false, status: 503 }) as Response)
    const bounded = new SyncClient(
      [{ name: 'transcripts', table: new SyncTable(db, 'transcripts', [...SYNC_COLUMNS.transcripts]) }],
      { baseUrl: 'http://sync', token: 'tok', retryCount: 2 },
      new MemorySyncState(),
      { fetch: unavailable as unknown as typeof fetch, delay: async () => {} }
    )
    await expect(bounded.syncOnce()).rejects.toThrow(/503/)
    expect(unavailable).toHaveBeenCalledTimes(3)
  })
})
