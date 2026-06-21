import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js'
import { HistoryStore } from '../src/main/store/history'
import { DictionaryStore } from '../src/main/store/dictionary'
import { SyncTable, SYNC_COLUMNS, type RemoteRecord } from '../src/main/sync/sync-table'
import type { NewTranscript } from '@shared/types'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})

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

function transcriptTable(db: Database): SyncTable {
  return new SyncTable(db, 'transcripts', [...SYNC_COLUMNS.transcripts])
}

describe('SyncTable — changedSince', () => {
  it('returns rows changed after the watermark with sync meta + data', () => {
    const db = new SQL.Database()
    const store = new HistoryStore(db, () => {}, () => 5000)
    store.insert(base({ raw_text: 'first' }))
    const changes = transcriptTable(db).changedSince(0)
    expect(changes).toHaveLength(1)
    expect(changes[0].uuid).not.toBe('')
    expect(changes[0].updatedAt).toBe(5000)
    expect(changes[0].deleted).toBe(false)
    expect(changes[0].data.raw_text).toBe('first')
  })

  it('excludes rows at or before the watermark', () => {
    const db = new SQL.Database()
    let clock = 0
    const store = new HistoryStore(db, () => {}, () => (clock += 100))
    store.insert(base({ raw_text: 'old' })) // updated_at 100
    store.insert(base({ raw_text: 'new' })) // updated_at 200
    const changes = transcriptTable(db).changedSince(100)
    expect(changes.map((c) => c.data.raw_text)).toEqual(['new'])
  })

  it('includes tombstones (soft-deleted rows)', () => {
    const db = new SQL.Database()
    let clock = 0
    const store = new HistoryStore(db, () => {}, () => (clock += 100))
    const t = store.insert(base())
    store.delete(t.id)
    const changes = transcriptTable(db).changedSince(0)
    expect(changes).toHaveLength(1)
    expect(changes[0].deleted).toBe(true)
  })
})

describe('SyncTable — applyRemote (last-write-wins)', () => {
  function remoteTranscript(uuid: string, updatedAt: number, raw: string): RemoteRecord {
    return {
      uuid,
      updatedAt,
      deleted: false,
      data: {
        created_at: updatedAt,
        raw_text: raw,
        cleaned_text: null,
        duration_ms: 1,
        word_count: 2,
        latency_ms: 3,
        app_context: 'phone',
        model: 'whisper-1',
        status: 'ok'
      }
    }
  }

  it('inserts a brand-new remote row by uuid', () => {
    const db = new SQL.Database()
    new HistoryStore(db) // create schema
    const applied = transcriptTable(db).applyRemote(remoteTranscript('r1', 5000, 'from phone'))
    expect(applied).toBe(true)
    const list = new HistoryStore(db).list({ limit: 10, offset: 0 })
    expect(list.map((r) => r.raw_text)).toContain('from phone')
  })

  it('skips an older remote and applies a newer one for the same uuid', () => {
    const db = new SQL.Database()
    new HistoryStore(db)
    const table = transcriptTable(db)
    table.applyRemote(remoteTranscript('r1', 200, 'v200'))
    expect(table.applyRemote(remoteTranscript('r1', 100, 'v100'))).toBe(false) // older — skip
    expect(table.applyRemote(remoteTranscript('r1', 300, 'v300'))).toBe(true) // newer — apply
    const list = new HistoryStore(db).list({ limit: 10, offset: 0 })
    expect(list.find((r) => r.raw_text === 'v300')).toBeTruthy()
    expect(list.find((r) => r.raw_text === 'v200')).toBeUndefined()
  })

  it('applies a remote tombstone that hides the row from reads', () => {
    const db = new SQL.Database()
    new HistoryStore(db)
    const table = transcriptTable(db)
    table.applyRemote(remoteTranscript('r1', 100, 'live'))
    const tombstone = { ...remoteTranscript('r1', 200, 'live'), deleted: true }
    expect(table.applyRemote(tombstone)).toBe(true)
    expect(new HistoryStore(db).list({ limit: 10, offset: 0 })).toHaveLength(0)
  })
})

describe('SyncTable — dictionary cross-device', () => {
  it('does not throw when a remote word duplicates a local active word', () => {
    const db = new SQL.Database()
    const store = new DictionaryStore(db, () => {}, () => 1000)
    store.add('Bryan', ['Brian'], 'manual') // local active Bryan
    const table = new SyncTable(db, 'dictionary', [...SYNC_COLUMNS.dictionary])
    // A different device independently added "Bryan" (its own uuid). Merging the two
    // must NOT hit a unique-word constraint and wedge dictionary sync.
    expect(() =>
      table.applyRemote({
        uuid: 'remote-bryan',
        updatedAt: 2000,
        deleted: false,
        data: {
          word: 'Bryan',
          misheard: '["Bryanne"]',
          source: 'manual',
          created_at: 2000,
          times_applied: 0
        }
      })
    ).not.toThrow()
  })
})
