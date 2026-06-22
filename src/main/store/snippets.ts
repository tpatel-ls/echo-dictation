import type { Database, SqlValue } from 'sql.js'
import type { Snippet } from '@shared/snippets'
import { ensureSyncColumns } from './migrate'
import { monotonicClock } from './clock'
import { randomUUID } from 'node:crypto'

// Voice snippets over the shared sql.js database. Columns (cue, expansion, created_at) + the sync
// columns match the Android schema byte-for-byte so a snippet authored on the phone syncs here.

export interface SnippetRow extends Snippet {
  id: number
  created_at: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snippets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cue TEXT NOT NULL,
  expansion TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

export class SnippetsStore {
  constructor(
    private db: Database,
    private onChange: () => void = () => {},
    private now: () => number = monotonicClock()
  ) {
    this.db.run(SCHEMA)
    ensureSyncColumns(this.db, 'snippets')
  }

  list(): SnippetRow[] {
    return this.query('SELECT * FROM snippets WHERE deleted = 0 ORDER BY created_at DESC, id DESC', [])
  }

  add(cue: string, expansion: string): SnippetRow {
    const c = cue.trim()
    if (!c) throw new Error('A snippet cue is required')
    const ts = this.now()
    this.db.run(
      'INSERT INTO snippets (cue, expansion, created_at, uuid, updated_at, deleted) VALUES (?,?,?,?,?,0)',
      [c, expansion, ts, randomUUID(), ts]
    )
    const id = this.scalar('SELECT last_insert_rowid()')
    this.onChange()
    return { id, cue: c, expansion, created_at: ts }
  }

  update(id: number, patch: { cue?: string; expansion?: string }): void {
    const cur = this.query('SELECT * FROM snippets WHERE id = ? AND deleted = 0', [id])[0]
    if (!cur) return
    const cue = (patch.cue ?? cur.cue).trim()
    const expansion = patch.expansion ?? cur.expansion
    this.db.run('UPDATE snippets SET cue = ?, expansion = ?, updated_at = ? WHERE id = ?', [
      cue,
      expansion,
      this.now(),
      id
    ])
    this.onChange()
  }

  /** Soft-delete: keep a tombstone (deleted=1) so the deletion can sync. */
  delete(id: number): void {
    this.db.run('UPDATE snippets SET deleted = 1, updated_at = ? WHERE id = ?', [this.now(), id])
    this.onChange()
  }

  private query(sql: string, params: SqlValue[]): SnippetRow[] {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const rows: SnippetRow[] = []
    while (stmt.step()) {
      const o = stmt.getAsObject()
      rows.push({
        id: o.id as number,
        cue: o.cue as string,
        expansion: o.expansion as string,
        created_at: o.created_at as number
      })
    }
    stmt.free()
    return rows
  }

  private scalar(sql: string): number {
    const stmt = this.db.prepare(sql)
    let v = 0
    if (stmt.step()) v = (stmt.get()[0] as number) ?? 0
    stmt.free()
    return v
  }
}
