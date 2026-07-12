import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js'
import { HistoryStore } from '../src/main/store/history'
import { retainAudioCopy } from '../src/main/store/history-file'
import type { NewTranscript } from '@shared/types'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')
const electronMock = vi.hoisted(() => ({
  getPath: vi.fn(() => '/tmp'),
  getAppPath: vi.fn(() => process.cwd())
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: electronMock.getPath,
    getAppPath: electronMock.getAppPath
  }
}))

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

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})
function newStore(onChange?: () => void): HistoryStore {
  return new HistoryStore(new SQL.Database(), onChange)
}

/** Read the sync columns straight off the DB (they aren't on the public Transcript type). */
function syncMeta(db: Database, id: number): { uuid: string; updated_at: number; deleted: number } {
  const stmt = db.prepare('SELECT uuid, updated_at, deleted FROM transcripts WHERE id = ?')
  stmt.bind([id])
  stmt.step()
  const o = stmt.getAsObject()
  stmt.free()
  return { uuid: o.uuid as string, updated_at: o.updated_at as number, deleted: o.deleted as number }
}

describe('HistoryStore', () => {
  it('inserts and returns a row with an id', () => {
    const store = newStore()
    const t = store.insert(base())
    expect(t.id).toBeGreaterThan(0)
    expect(t.raw_text).toBe('hello world')
    expect(store.get(t.id)?.id).toBe(t.id)
  })

  it('lists newest first with paging', () => {
    const store = newStore()
    store.insert(base({ created_at: 1, raw_text: 'first' }))
    store.insert(base({ created_at: 2, raw_text: 'second' }))
    store.insert(base({ created_at: 3, raw_text: 'third' }))
    expect(store.list({ limit: 2, offset: 0 }).map((r) => r.raw_text)).toEqual(['third', 'second'])
    expect(store.list({ limit: 2, offset: 2 }).map((r) => r.raw_text)).toEqual(['first'])
  })

  it('searches raw and cleaned text', () => {
    const store = newStore()
    store.insert(base({ raw_text: 'buy milk and eggs' }))
    store.insert(base({ raw_text: 'call the dentist', cleaned_text: 'Call the dentist.' }))
    expect(store.search('milk', { limit: 10, offset: 0 })).toHaveLength(1)
    expect(store.search('dentist', { limit: 10, offset: 0 })).toHaveLength(1)
    expect(store.search('zzz', { limit: 10, offset: 0 })).toHaveLength(0)
  })

  it('filters list and search results by status and minimum date', () => {
    const store = newStore()
    store.insert(base({ created_at: 100, raw_text: 'old success', status: 'ok' }))
    store.insert(base({ created_at: 200, raw_text: 'recent failure', status: 'failed' }))
    store.insert(base({ created_at: 300, raw_text: 'recent success', status: 'ok' }))
    store.insert(base({ created_at: 400, raw_text: '', status: 'empty' }))

    expect(store.list({ limit: 10, offset: 0, status: 'ok', from: 150 }).map((row) => row.raw_text))
      .toEqual(['recent success'])
    expect(store.search('recent', { limit: 10, offset: 0, status: 'failed', from: 150 })
      .map((row) => row.raw_text)).toEqual(['recent failure'])
  })

  it('updates cleaned text', () => {
    const store = newStore()
    const t = store.insert(base())
    expect(store.updateCleaned(t.id, 'Hello, world.')?.cleaned_text).toBe('Hello, world.')
  })

  it('replaces a failed transcript after retry while preserving its retained audio', () => {
    const store = newStore()
    const t = store.insert(
      base({ status: 'failed', raw_text: 'Low confidence transcription', audio_path: '/tmp/retry.wav' })
    )
    const retried = store.updateRetried(t.id, {
      rawText: 'How is it going today?',
      cleanedText: null,
      model: 'native',
      latencyMs: 420
    })

    expect(retried).toMatchObject({
      status: 'ok',
      raw_text: 'How is it going today?',
      cleaned_text: null,
      word_count: 5,
      model: 'native',
      latency_ms: 420,
      audio_path: '/tmp/retry.wav'
    })
  })

  it('deletes a row', () => {
    const store = newStore()
    const t = store.insert(base())
    store.delete(t.id)
    expect(store.get(t.id)).toBeNull()
  })

  it('clears failed and empty attempts in one sync-visible change', () => {
    const changed = vi.fn()
    const store = newStore(changed)
    store.insert(base({ raw_text: 'keep', status: 'ok' }))
    const failed = store.insert(base({ raw_text: 'failed', status: 'failed', audio_path: '/tmp/f.wav' }))
    const empty = store.insert(base({ raw_text: '', status: 'empty' }))
    changed.mockClear()

    const removed = store.clearUnsuccessful()

    expect(removed.map((row) => row.id).sort()).toEqual([failed.id, empty.id].sort())
    expect(store.list({ limit: 10, offset: 0 }).map((row) => row.raw_text)).toEqual(['keep'])
    expect(changed).toHaveBeenCalledOnce()
  })

  it('does not emit a change when there is nothing unsuccessful to clear', () => {
    const changed = vi.fn()
    const store = newStore(changed)
    store.insert(base({ status: 'ok' }))
    changed.mockClear()
    expect(store.clearUnsuccessful()).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  })

  it('aggregates stats and counts today + streak', () => {
    const store = newStore()
    const now = new Date('2026-06-08T12:00:00').getTime()
    const earlierToday = new Date('2026-06-08T08:00:00').getTime()
    const yesterday = new Date('2026-06-07T12:00:00').getTime()
    store.insert(base({ created_at: earlierToday, word_count: 10 }))
    store.insert(base({ created_at: yesterday, word_count: 5 }))
    const s = store.stats(now)
    expect(s.totalTranscripts).toBe(2)
    expect(s.totalWords).toBe(15)
    expect(s.todayWords).toBe(10)
    expect(s.todayCount).toBe(1)
    expect(s.streakDays).toBe(2)
  })

  it('excludes failed rows from stats', () => {
    const store = newStore()
    const now = new Date('2026-06-08T12:00:00').getTime()
    store.insert(base({ created_at: now, word_count: 7, status: 'failed' }))
    expect(store.stats(now).totalWords).toBe(0)
  })

  it('updateEdited rewrites raw_text and word_count when there is no cleaned text', () => {
    const store = newStore()
    const t = store.insert(base({ raw_text: 'I saw Brian today', word_count: 4 }))
    const u = store.updateEdited(t.id, 'I saw Bryan today, briefly')
    expect(u?.raw_text).toBe('I saw Bryan today, briefly')
    expect(u?.cleaned_text).toBeNull()
    expect(u?.word_count).toBe(5)
  })

  it('updateEdited rewrites cleaned_text when present, leaving raw_text intact', () => {
    const store = newStore()
    const t = store.insert(base({ raw_text: 'i saw brian', cleaned_text: 'I saw Brian.' }))
    const u = store.updateEdited(t.id, 'I saw Bryan.')
    expect(u?.cleaned_text).toBe('I saw Bryan.')
    expect(u?.raw_text).toBe('i saw brian')
  })

  it('updateEdited returns null for a missing id', () => {
    const store = newStore()
    expect(store.updateEdited(12345, 'x')).toBeNull()
  })

  it('fires onChange on insert/update/delete', () => {
    let n = 0
    const store = newStore(() => {
      n++
    })
    const t = store.insert(base())
    store.updateCleaned(t.id, 'x')
    store.delete(t.id)
    expect(n).toBe(3)
  })
})

describe('HistoryStore sync write-path', () => {
  it('stamps a unique uuid and updated_at on insert', () => {
    const db = new SQL.Database()
    const store = new HistoryStore(db, () => {}, () => 7000)
    const a = store.insert(base())
    const b = store.insert(base())
    const ma = syncMeta(db, a.id)
    expect(ma.uuid).not.toBe('')
    expect(ma.uuid).not.toBe(syncMeta(db, b.id).uuid) // unique per row
    expect(ma.updated_at).toBe(7000)
    expect(ma.deleted).toBe(0)
  })

  it('bumps updated_at on updateCleaned and updateEdited', () => {
    const db = new SQL.Database()
    let clock = 1000
    const store = new HistoryStore(db, () => {}, () => (clock += 1000))
    const t = store.insert(base()) // updated_at = 2000
    store.updateCleaned(t.id, 'x') // 3000
    expect(syncMeta(db, t.id).updated_at).toBe(3000)
    store.updateEdited(t.id, 'y z') // 4000
    expect(syncMeta(db, t.id).updated_at).toBe(4000)
  })

  it('soft-deletes: hidden from reads but retained as a tombstone', () => {
    const db = new SQL.Database()
    let clock = 0
    const store = new HistoryStore(db, () => {}, () => (clock += 100))
    const t = store.insert(base())
    store.delete(t.id)
    expect(store.get(t.id)).toBeNull()
    expect(store.list({ limit: 10, offset: 0 })).toHaveLength(0)
    const m = syncMeta(db, t.id)
    expect(m.deleted).toBe(1)
    expect(m.updated_at).toBeGreaterThan(0)
  })

  it('excludes soft-deleted rows from search and stats', () => {
    const db = new SQL.Database()
    const store = new HistoryStore(db, () => {}, () => 1)
    const now = new Date('2026-06-08T12:00:00').getTime()
    const keep = store.insert(base({ created_at: now, raw_text: 'keep me', word_count: 2 }))
    const gone = store.insert(base({ created_at: now, raw_text: 'delete me', word_count: 5 }))
    store.delete(gone.id)
    expect(store.search('me', { limit: 10, offset: 0 }).map((r) => r.id)).toEqual([keep.id])
    const s = store.stats(now)
    expect(s.totalTranscripts).toBe(1)
    expect(s.totalWords).toBe(2)
  })
})

describe('history audio retention', () => {
  it('copies a temporary wav into retained history storage without deleting the temp file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'echo-history-audio-'))
    electronMock.getPath.mockReturnValue(dir)
    const temp = path.join(dir, 'temp.wav')
    writeFileSync(temp, Buffer.from([9, 8, 7]))

    try {
      const retained = retainAudioCopy(temp, { now: () => 1234, random: () => 0.42 })

      expect(retained).toBe(path.join(dir, 'audio', '1234-420000.wav'))
      if (!retained) throw new Error('expected retained audio path')
      expect(readFileSync(retained)).toEqual(Buffer.from([9, 8, 7]))
      expect(existsSync(temp)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
