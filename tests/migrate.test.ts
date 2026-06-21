import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js'
import { ensureSyncColumns } from '../src/main/store/migrate'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})

function columns(db: Database, table: string): string[] {
  const stmt = db.prepare(`PRAGMA table_info(${table})`)
  const names: string[] = []
  while (stmt.step()) names.push(stmt.getAsObject().name as string)
  stmt.free()
  return names
}

function allRows(db: Database, table: string): Array<Record<string, unknown>> {
  const stmt = db.prepare(`SELECT * FROM ${table}`)
  const rows: Array<Record<string, unknown>> = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}

describe('ensureSyncColumns', () => {
  it('adds uuid, updated_at, and deleted when missing', () => {
    const db = new SQL.Database()
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER)')
    ensureSyncColumns(db, 't')
    expect(columns(db, 't')).toEqual(expect.arrayContaining(['uuid', 'updated_at', 'deleted']))
  })

  it('is idempotent (running twice neither errors nor duplicates a column)', () => {
    const db = new SQL.Database()
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER)')
    ensureSyncColumns(db, 't')
    ensureSyncColumns(db, 't')
    expect(columns(db, 't').filter((c) => c === 'uuid')).toHaveLength(1)
  })

  it('backfills pre-existing rows with a unique uuid and updated_at = created_at', () => {
    const db = new SQL.Database()
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER)')
    db.run('INSERT INTO t (created_at) VALUES (5000)')
    db.run('INSERT INTO t (created_at) VALUES (6000)')
    ensureSyncColumns(db, 't')
    const rows = allRows(db, 't')
    expect(rows.every((r) => typeof r.uuid === 'string' && (r.uuid as string).length > 0)).toBe(true)
    expect(new Set(rows.map((r) => r.uuid)).size).toBe(2) // each backfilled uuid is unique
    expect(rows.find((r) => r.created_at === 5000)?.updated_at).toBe(5000)
    expect(rows.find((r) => r.created_at === 6000)?.updated_at).toBe(6000)
  })

  it('gives rows that share a created_at distinct, ordered updated_at values', () => {
    const db = new SQL.Database()
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER)')
    db.run('INSERT INTO t (created_at) VALUES (5000)')
    db.run('INSERT INTO t (created_at) VALUES (5000)')
    db.run('INSERT INTO t (created_at) VALUES (5000)')
    ensureSyncColumns(db, 't')
    const ups = allRows(db, 't').map((r) => r.updated_at as number)
    expect(new Set(ups).size).toBe(3) // all distinct — no tie to strand the sync push
    expect([...ups].sort((a, b) => a - b)).toEqual([5000, 5001, 5002])
  })

  it('leaves rows that already have a uuid untouched', () => {
    const db = new SQL.Database()
    db.run(
      "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER, uuid TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0)"
    )
    db.run("INSERT INTO t (created_at, uuid, updated_at) VALUES (5000, 'keep-me', 4000)")
    ensureSyncColumns(db, 't')
    const rows = allRows(db, 't')
    expect(rows[0].uuid).toBe('keep-me')
    expect(rows[0].updated_at).toBe(4000) // not overwritten with created_at
  })
})
