import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js'
import { DictionaryStore } from '../src/main/store/dictionary'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})
function newStore(onChange?: () => void): DictionaryStore {
  return new DictionaryStore(new SQL.Database(), onChange)
}

describe('DictionaryStore', () => {
  it('adds an entry and round-trips word, aliases and source', () => {
    const store = newStore()
    const e = store.add('Bryan', ['Brian'], 'manual')
    expect(e.id).toBeGreaterThan(0)
    expect(e.word).toBe('Bryan')
    expect(e.misheard).toEqual(['Brian'])
    expect(e.source).toBe('manual')
    expect(e.times_applied).toBe(0)
    expect(store.list()).toEqual([e])
  })

  it('normalizes input: trims, dedupes aliases, drops alias equal to word', () => {
    const store = newStore()
    const e = store.add('  Bryan ', [' Brian ', 'brian', 'Bryan', ''], 'manual')
    expect(e.word).toBe('Bryan')
    expect(e.misheard).toEqual(['Brian'])
  })

  it('rejects an empty word', () => {
    const store = newStore()
    expect(() => store.add('   ', [], 'manual')).toThrow(/word/i)
  })

  it('upserts: re-adding an existing word (case-insensitive) merges aliases', () => {
    const store = newStore()
    const first = store.add('Bryan', ['Brian'], 'manual')
    const merged = store.add('bryan', ['Brain'], 'learned')
    expect(merged.id).toBe(first.id)
    expect(merged.word).toBe('Bryan') // original casing kept
    expect(merged.misheard.sort()).toEqual(['Brain', 'Brian'])
    expect(merged.source).toBe('manual') // original source kept
    expect(store.list()).toHaveLength(1)
  })

  it('moves a conflicting alias to the most recently assigned canonical word', () => {
    const store = newStore()
    const first = store.add('Acme Cloud', ['acme'], 'manual')
    const second = store.add('Acme Desktop', ['ACME'], 'manual')

    expect(store.get(first.id)?.misheard).toEqual([])
    expect(store.get(second.id)?.misheard).toEqual(['ACME'])
  })

  it('never allows another canonical word to be claimed as an alias', () => {
    const store = newStore()
    store.add('GitHub', [], 'manual')
    const other = store.add('GitLab', ['github', 'git lab app'], 'manual')
    expect(other.misheard).toEqual(['git lab app'])
  })

  it('resolves alias conflicts when an existing entry is updated', () => {
    const store = newStore()
    const first = store.add('First', ['shared'], 'manual')
    const second = store.add('Second', [], 'manual')
    store.update(second.id, { misheard: ['Shared'] })

    expect(store.get(first.id)?.misheard).toEqual([])
    expect(store.get(second.id)?.misheard).toEqual(['Shared'])
  })

  it('updates word and aliases', () => {
    const store = newStore()
    const e = store.add('Bryan', ['Brian'], 'manual')
    const u = store.update(e.id, { word: 'Bryan K', misheard: ['Brian', 'Brian K'] })
    expect(u?.word).toBe('Bryan K')
    expect(u?.misheard).toEqual(['Brian', 'Brian K'])
    expect(store.update(999, { word: 'x' })).toBeNull()
  })

  it('deletes an entry', () => {
    const store = newStore()
    const e = store.add('Bryan', [], 'manual')
    store.delete(e.id)
    expect(store.list()).toEqual([])
  })

  it('removes a single alias case-insensitively (for undo)', () => {
    const store = newStore()
    const e = store.add('Bryan', ['Brian', 'Brain'], 'manual')
    const u = store.removeAlias(e.id, 'brian')
    expect(u?.misheard).toEqual(['Brain'])
  })

  it('increments times_applied for the given ids', () => {
    const store = newStore()
    const a = store.add('Bryan', [], 'manual')
    const b = store.add('Tanay', [], 'manual')
    store.recordApplied([a.id])
    store.recordApplied([a.id, b.id])
    const byWord = Object.fromEntries(store.list().map((e) => [e.word, e.times_applied]))
    expect(byWord).toEqual({ Bryan: 2, Tanay: 1 })
  })

  it('lists newest first', () => {
    const store = newStore()
    store.add('First', [], 'manual')
    store.add('Second', [], 'manual')
    const words = store.list().map((e) => e.word)
    expect(words).toEqual(['Second', 'First'])
  })

  it('fires onChange on every mutation', () => {
    let n = 0
    const store = newStore(() => {
      n++
    })
    const e = store.add('Bryan', ['Brian'], 'manual')
    store.update(e.id, { misheard: [] })
    store.recordApplied([e.id])
    store.delete(e.id)
    expect(n).toBe(4)
  })
})

function dictMeta(db: Database, id: number): { uuid: string; updated_at: number; deleted: number } {
  const stmt = db.prepare('SELECT uuid, updated_at, deleted FROM dictionary WHERE id = ?')
  stmt.bind([id])
  stmt.step()
  const o = stmt.getAsObject()
  stmt.free()
  return { uuid: o.uuid as string, updated_at: o.updated_at as number, deleted: o.deleted as number }
}

describe('DictionaryStore sync write-path', () => {
  it('stamps a unique uuid and updated_at on add', () => {
    const db = new SQL.Database()
    const store = new DictionaryStore(db, () => {}, () => 7000)
    const a = store.add('Bryan', ['Brian'], 'manual')
    const b = store.add('Tanay', [], 'manual')
    const m = dictMeta(db, a.id)
    expect(m.uuid).not.toBe('')
    expect(m.uuid).not.toBe(dictMeta(db, b.id).uuid)
    expect(m.updated_at).toBe(7000)
    expect(m.deleted).toBe(0)
  })

  it('bumps updated_at on update and recordApplied', () => {
    const db = new SQL.Database()
    let clock = 1000
    const store = new DictionaryStore(db, () => {}, () => (clock += 1000))
    const e = store.add('Bryan', [], 'manual') // add → 2000
    store.update(e.id, { misheard: ['Brian'] }) // 3000
    expect(dictMeta(db, e.id).updated_at).toBe(3000)
    store.recordApplied([e.id]) // 4000
    expect(dictMeta(db, e.id).updated_at).toBe(4000)
  })

  it('soft-deletes: hidden from list/get but retained as a tombstone', () => {
    const db = new SQL.Database()
    let clock = 0
    const store = new DictionaryStore(db, () => {}, () => (clock += 100))
    const e = store.add('Bryan', [], 'manual')
    store.delete(e.id)
    expect(store.list()).toEqual([])
    expect(store.get(e.id)).toBeNull()
    const m = dictMeta(db, e.id)
    expect(m.deleted).toBe(1)
    expect(m.updated_at).toBeGreaterThan(0)
  })

  it('allows re-adding a soft-deleted word as a fresh active entry', () => {
    const db = new SQL.Database()
    const store = new DictionaryStore(db, () => {}, () => 1)
    const first = store.add('Bryan', ['Brian'], 'manual')
    store.delete(first.id)
    const second = store.add('Bryan', ['Bryanne'], 'manual') // must not hit a unique-index conflict
    expect(second.id).not.toBe(first.id) // a new entry, not a merge into the tombstone
    expect(store.list().map((e) => e.word)).toEqual(['Bryan'])
    expect(second.misheard).toEqual(['Bryanne'])
  })

  it('recordApplied never mutates a soft-deleted tombstone', () => {
    const db = new SQL.Database()
    let clock = 0
    const store = new DictionaryStore(db, () => {}, () => (clock += 100))
    const e = store.add('Bryan', [], 'manual') // 100
    store.delete(e.id) // 200
    const before = dictMeta(db, e.id).updated_at
    store.recordApplied([e.id]) // a stale id must be a no-op, not a tombstone bump
    expect(dictMeta(db, e.id).updated_at).toBe(before)
  })
})
