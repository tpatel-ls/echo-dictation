import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { HistoryStore } from '../src/main/store/history'
import type { NewTranscript } from '@shared/types'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')

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

  it('updates cleaned text', () => {
    const store = newStore()
    const t = store.insert(base())
    expect(store.updateCleaned(t.id, 'Hello, world.')?.cleaned_text).toBe('Hello, world.')
  })

  it('deletes a row', () => {
    const store = newStore()
    const t = store.insert(base())
    store.delete(t.id)
    expect(store.get(t.id)).toBeNull()
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
