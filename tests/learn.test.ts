import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { DictionaryStore } from '../src/main/store/dictionary'
import { learnFromEdit } from '../src/main/learn'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})
function newStore(): DictionaryStore {
  return new DictionaryStore(new SQL.Database())
}

describe('learnFromEdit', () => {
  it('learns a new correction as a learned entry', () => {
    const dict = newStore()
    const learned = learnFromEdit(dict, 'Email Brian about it', 'Email Bryan about it')
    expect(learned).toHaveLength(1)
    expect(learned[0]).toMatchObject({ from: 'Brian', to: 'Bryan', createdEntry: true })

    const entries = dict.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].word).toBe('Bryan')
    expect(entries[0].misheard).toEqual(['Brian'])
    expect(entries[0].source).toBe('learned')
    expect(learned[0].entryId).toBe(entries[0].id)
  })

  it('merges into an existing entry instead of creating a duplicate', () => {
    const dict = newStore()
    dict.add('Bryan', ['Brain'], 'manual')
    const learned = learnFromEdit(dict, 'ping Brian', 'ping Bryan')
    expect(learned).toHaveLength(1)
    expect(learned[0].createdEntry).toBe(false)
    const entries = dict.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].misheard.sort()).toEqual(['Brain', 'Brian'])
    expect(entries[0].source).toBe('manual')
  })

  it('skips corrections already covered by an alias', () => {
    const dict = newStore()
    dict.add('Bryan', ['Brian'], 'manual')
    expect(learnFromEdit(dict, 'ping Brian', 'ping Bryan')).toEqual([])
  })

  it('skips when the corrected-away word is itself a dictionary word', () => {
    const dict = newStore()
    dict.add('Brian', [], 'manual') // user knows a real Brian too
    expect(learnFromEdit(dict, 'ping Brian', 'ping Bryan')).toEqual([])
    expect(dict.list()).toHaveLength(1)
  })

  it('dedupes the same correction appearing twice in one edit', () => {
    const dict = newStore()
    const learned = learnFromEdit(dict, 'Brian met Brian', 'Bryan met Bryan')
    expect(learned).toHaveLength(1)
    expect(dict.list()[0].misheard).toEqual(['Brian'])
  })

  it('learns nothing from punctuation-only edits', () => {
    const dict = newStore()
    expect(learnFromEdit(dict, 'hello world', 'hello, world.')).toEqual([])
    expect(dict.list()).toEqual([])
  })
})
