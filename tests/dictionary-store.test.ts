import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
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
