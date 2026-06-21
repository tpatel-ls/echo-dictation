import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { openSyncDb } from '../src/server/db'

const WASM = join(process.cwd(), 'node_modules', 'sql.js', 'dist')
const DIR = join(tmpdir(), 'echo-sync-test')
const DB = join(DIR, 'sync.sqlite')

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true })
})

describe('openSyncDb', () => {
  it('persists records across a reopen', async () => {
    const a = await openSyncDb(DB, WASM)
    a.store.upsert('transcripts', { uuid: 'x', updatedAt: 100, deleted: false, payload: '{"v":1}' })
    a.flush()
    expect(existsSync(DB)).toBe(true)

    const b = await openSyncDb(DB, WASM)
    const recs = b.store.since('transcripts', 0, 10).records
    expect(recs.map((r) => r.uuid)).toEqual(['x'])
    expect(recs[0].payload).toBe('{"v":1}')
  })

  it('creates a fresh empty db when the file does not exist', async () => {
    const h = await openSyncDb(DB, WASM)
    expect(h.store.since('transcripts', 0, 10).records).toEqual([])
  })

  it('creates the parent directory if missing', async () => {
    const nested = join(DIR, 'deep', 'nested', 'sync.sqlite')
    const h = await openSyncDb(nested, WASM)
    h.store.upsert('dictionary', { uuid: 'd', updatedAt: 1, deleted: false, payload: '{}' })
    h.flush()
    expect(existsSync(nested)).toBe(true)
  })

  it('recovers from a corrupt db file: starts fresh and preserves the bad file', async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(DB, 'this is not a sqlite database')
    const h = await openSyncDb(DB, WASM) // must not throw — a supervised service must self-heal
    expect(h.store.since('transcripts', 0, 10).records).toEqual([])
    const movedAside = readdirSync(DIR).filter((f) => f.startsWith('sync.sqlite.corrupt-'))
    expect(movedAside).toHaveLength(1)
  })
})
