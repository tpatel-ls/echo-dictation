import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { SyncStore } from '../src/server/sync-store'
import { createServer, handleSyncRequest } from '../src/server/http'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})

interface Running {
  url: string
  store: SyncStore
  close: () => Promise<void>
}

function start(token = 'secret'): Promise<Running> {
  const store = new SyncStore(new SQL.Database())
  const server = createServer(store, token)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        store,
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

const auth = (token = 'secret'): Record<string, string> => ({ authorization: `Bearer ${token}` })

describe('sync HTTP service', () => {
  it('serves /health without auth', async () => {
    const s = await start()
    try {
      const r = await fetch(`${s.url}/health`)
      expect(r.status).toBe(200)
      expect(((await r.json()) as { ok: boolean }).ok).toBe(true)
    } finally {
      await s.close()
    }
  })

  it('rejects a pull without a valid bearer token', async () => {
    const s = await start('secret')
    try {
      expect((await fetch(`${s.url}/sync/transcripts?since=0`)).status).toBe(401)
      expect((await fetch(`${s.url}/sync/transcripts?since=0`, { headers: auth('wrong') })).status).toBe(401)
    } finally {
      await s.close()
    }
  })

  it('stores a pushed record and returns it on an authorized pull', async () => {
    const s = await start('secret')
    try {
      const push = await fetch(`${s.url}/sync/transcripts`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({
          records: [{ uuid: 'a', updatedAt: 100, deleted: false, payload: '{"raw":"hi"}' }]
        })
      })
      expect(push.status).toBe(200)
      const pushed = (await push.json()) as { applied: number; cursor?: number }
      expect(pushed.applied).toBe(1)
      expect(pushed.cursor).toBeUndefined() // push confirms count only; pull cursor never comes from a push

      const pull = await fetch(`${s.url}/sync/transcripts?since=0`, { headers: auth() })
      expect(pull.status).toBe(200)
      const data = (await pull.json()) as {
        records: Array<{ uuid: string; payload: string | null }>
        hasMore: boolean
      }
      expect(data.records).toHaveLength(1)
      expect(data.records[0].uuid).toBe('a')
      expect(data.records[0].payload).toBe('{"raw":"hi"}')
      expect(data.hasMore).toBe(false)
    } finally {
      await s.close()
    }
  })

  it('round-trips a snippet record (the snippets collection is allowed)', async () => {
    const s = await start('secret')
    try {
      const payload = '{"cue":"my address","expansion":"123 Main St"}'
      const push = await fetch(`${s.url}/sync/snippets`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ records: [{ uuid: 's1', updatedAt: 100, deleted: false, payload }] })
      })
      expect(push.status).toBe(200)
      expect(((await push.json()) as { applied: number }).applied).toBe(1)

      const pull = await fetch(`${s.url}/sync/snippets?since=0`, { headers: auth() })
      expect(pull.status).toBe(200)
      const data = (await pull.json()) as { records: Array<{ uuid: string; payload: string | null }> }
      expect(data.records).toHaveLength(1)
      expect(data.records[0].uuid).toBe('s1')
      expect(data.records[0].payload).toBe(payload)
    } finally {
      await s.close()
    }
  })

  it('404s an unknown collection', async () => {
    const s = await start('secret')
    try {
      const r = await fetch(`${s.url}/sync/bogus?since=0`, { headers: auth() })
      expect(r.status).toBe(404)
    } finally {
      await s.close()
    }
  })

  it('400s an invalid push body', async () => {
    const s = await start('secret')
    try {
      const r = await fetch(`${s.url}/sync/transcripts`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ nope: true })
      })
      expect(r.status).toBe(400)
    } finally {
      await s.close()
    }
  })

  it('400s a record whose updatedAt is non-finite (JSON literal 1e309 → Infinity)', async () => {
    const s = await start('secret')
    try {
      const r = await fetch(`${s.url}/sync/transcripts`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        // Hand-built body: JSON.stringify(Infinity) would emit null, so write the raw literal.
        body: '{"records":[{"uuid":"x","updatedAt":1e309,"deleted":false,"payload":null}]}'
      })
      expect(r.status).toBe(400)
    } finally {
      await s.close()
    }
  })

  it('404s a collection with a malformed percent-escape instead of leaking an error', async () => {
    const s = await start('secret')
    try {
      // %C3%28 is a syntactically valid escape but invalid UTF-8, so decodeURIComponent throws.
      const r = await fetch(`${s.url}/sync/%C3%28`, { headers: auth() })
      expect(r.status).toBe(404)
    } finally {
      await s.close()
    }
  })
})

describe('handleSyncRequest (pure routing)', () => {
  function store(): SyncStore {
    return new SyncStore(new SQL.Database())
  }

  it('405s an unsupported method', () => {
    const res = handleSyncRequest(store(), 'secret', {
      method: 'DELETE',
      collection: 'transcripts',
      since: 0,
      limit: NaN,
      authToken: 'secret',
      body: null,
      isHealth: false
    })
    expect(res.status).toBe(405)
  })

  it('does not require auth for health', () => {
    const res = handleSyncRequest(store(), 'secret', {
      method: 'GET',
      collection: null,
      since: 0,
      limit: NaN,
      authToken: null,
      body: null,
      isHealth: true
    })
    expect(res.status).toBe(200)
  })
})
