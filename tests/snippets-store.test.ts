import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { SnippetsStore } from '../src/main/store/snippets'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')
let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})

describe('SnippetsStore', () => {
  it('adds and lists active snippets', () => {
    const s = new SnippetsStore(new SQL.Database())
    s.add('my address', '123 Main St')
    const rows = s.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].cue).toBe('my address')
    expect(rows[0].expansion).toBe('123 Main St')
  })

  it('soft-deletes (tombstone, not in list)', () => {
    const s = new SnippetsStore(new SQL.Database())
    const r = s.add('cue', 'exp')
    s.delete(r.id)
    expect(s.list()).toHaveLength(0)
  })

  it('updates cue and expansion', () => {
    const s = new SnippetsStore(new SQL.Database())
    const r = s.add('a', 'x')
    s.update(r.id, { cue: 'b', expansion: 'y' })
    const row = s.list()[0]
    expect(row.cue).toBe('b')
    expect(row.expansion).toBe('y')
  })

  it('requires a non-blank cue', () => {
    const s = new SnippetsStore(new SQL.Database())
    expect(() => s.add('  ', 'x')).toThrow()
  })
})
