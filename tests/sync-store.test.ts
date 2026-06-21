import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { SyncStore } from '../src/server/sync-store'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})

function newStore(): SyncStore {
  return new SyncStore(new SQL.Database())
}

function env(
  uuid: string,
  updatedAt: number,
  opts: { deleted?: boolean; payload?: string | null } = {}
): { uuid: string; updatedAt: number; deleted: boolean; payload: string | null } {
  return {
    uuid,
    updatedAt,
    deleted: opts.deleted ?? false,
    payload: 'payload' in opts ? (opts.payload ?? null) : `{"v":${updatedAt}}`
  }
}

describe('SyncStore.upsert', () => {
  it('inserts a new record and assigns a positive seq', () => {
    const s = newStore()
    const r = s.upsert('transcripts', env('a', 100))
    expect(r.applied).toBe(true)
    expect(r.seq).toBeGreaterThan(0)
  })

  it('skips an older update and leaves the stored payload intact', () => {
    const s = newStore()
    s.upsert('transcripts', env('a', 200, { payload: '{"v":200}' }))
    const r = s.upsert('transcripts', env('a', 199, { payload: '{"v":199}' }))
    expect(r.applied).toBe(false)
    const got = s.since('transcripts', 0, 10).records.find((x) => x.uuid === 'a')
    expect(got?.payload).toBe('{"v":200}')
  })

  it('applies a newer update and bumps seq above the previous', () => {
    const s = newStore()
    const first = s.upsert('transcripts', env('a', 100))
    const second = s.upsert('transcripts', env('a', 101))
    expect(second.applied).toBe(true)
    expect(second.seq).toBeGreaterThan(first.seq)
  })

  it('treats an equal timestamp as idempotent (no re-apply)', () => {
    const s = newStore()
    s.upsert('transcripts', env('a', 100))
    expect(s.upsert('transcripts', env('a', 100)).applied).toBe(false)
  })

  it('stores a tombstone that since() returns', () => {
    const s = newStore()
    s.upsert('transcripts', env('a', 100))
    s.upsert('transcripts', env('a', 101, { deleted: true, payload: null }))
    const rec = s.since('transcripts', 0, 10).records.find((x) => x.uuid === 'a')
    expect(rec?.deleted).toBe(true)
    expect(rec?.payload).toBeNull()
  })
})

describe('SyncStore.since', () => {
  it('returns all records from cursor 0 in seq order', () => {
    const s = newStore()
    s.upsert('transcripts', env('a', 100))
    s.upsert('transcripts', env('b', 101))
    const res = s.since('transcripts', 0, 10)
    expect(res.records.map((r) => r.uuid)).toEqual(['a', 'b'])
    expect(res.hasMore).toBe(false)
  })

  it('returns only records newer than the cursor', () => {
    const s = newStore()
    const a = s.upsert('transcripts', env('a', 100))
    s.upsert('transcripts', env('b', 101))
    expect(s.since('transcripts', a.seq, 10).records.map((r) => r.uuid)).toEqual(['b'])
  })

  it('caps at limit, reports hasMore, and yields an advanceable cursor', () => {
    const s = newStore()
    s.upsert('transcripts', env('a', 100))
    s.upsert('transcripts', env('b', 101))
    s.upsert('transcripts', env('c', 102))
    const res = s.since('transcripts', 0, 2)
    expect(res.records).toHaveLength(2)
    expect(res.hasMore).toBe(true)
    const next = s.since('transcripts', res.cursor, 2)
    expect(next.records.map((r) => r.uuid)).toEqual(['c'])
    expect(next.hasMore).toBe(false)
  })

  it('scopes records by collection', () => {
    const s = newStore()
    s.upsert('transcripts', env('a', 100))
    s.upsert('dictionary', env('d', 100))
    expect(s.since('transcripts', 0, 10).records.map((r) => r.uuid)).toEqual(['a'])
    expect(s.since('dictionary', 0, 10).records.map((r) => r.uuid)).toEqual(['d'])
  })
})

describe('SyncStore — review hardening', () => {
  it('normalizes a missing payload to null instead of crashing the bind', () => {
    const s = newStore()
    // A push body that omits the payload key deserializes to undefined; sql.js cannot
    // bind undefined, so the store must coerce it to null.
    const r = s.upsert('transcripts', { uuid: 'a', updatedAt: 100, deleted: true })
    expect(r.applied).toBe(true)
    expect(s.since('transcripts', 0, 10).records[0]?.payload).toBeNull()
  })

  it('numbers seq per collection, not from one global counter', () => {
    const s = newStore()
    const t = s.upsert('transcripts', env('a', 100))
    const d = s.upsert('dictionary', env('d', 100))
    expect(t.seq).toBe(1)
    expect(d.seq).toBe(1)
  })

  it('floors limit to 1 so a zero limit cannot loop a paginating client', () => {
    const s = newStore()
    s.upsert('transcripts', env('a', 100))
    const res = s.since('transcripts', 0, 0)
    expect(res.records).toHaveLength(1)
    expect(res.hasMore).toBe(false)
    expect(res.cursor).toBeGreaterThan(0)
  })
})
