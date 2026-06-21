import type { Database, SqlValue } from 'sql.js'
import { shouldApply } from '@shared/sync'

// Generic per-table sync bridge: reads local changes to push, and applies remote records
// by uuid using the shared last-write-wins rule. `table`/`dataColumns` are fixed internal
// config from the sync client (never user input), so interpolating them is safe — same
// convention as migrate.ts. `dataColumns` are the content columns that travel over the
// wire; the local autoincrement `id` and local-only columns (e.g. audio_path) are omitted.

export interface RemoteRecord {
  uuid: string
  updatedAt: number
  deleted: boolean
  data: Record<string, SqlValue>
}

export class SyncTable {
  constructor(
    private db: Database,
    private table: string,
    private dataColumns: string[]
  ) {}

  /** Local rows changed strictly after `watermark` (a local updated_at), oldest first. */
  changedSince(watermark: number): RemoteRecord[] {
    const cols = ['uuid', 'updated_at', 'deleted', ...this.dataColumns].join(', ')
    const stmt = this.db.prepare(
      `SELECT ${cols} FROM ${this.table} WHERE updated_at > ? ORDER BY updated_at ASC, id ASC`
    )
    stmt.bind([watermark])
    const out: RemoteRecord[] = []
    while (stmt.step()) {
      const o = stmt.getAsObject()
      const data: Record<string, SqlValue> = {}
      for (const c of this.dataColumns) data[c] = o[c] ?? null
      out.push({
        uuid: o.uuid as string,
        updatedAt: o.updated_at as number,
        deleted: (o.deleted as number) === 1,
        data
      })
    }
    stmt.free()
    return out
  }

  /** Apply a remote record by uuid, last-write-wins. Returns whether it changed anything. */
  applyRemote(rec: RemoteRecord): boolean {
    const local = this.metaByUuid(rec.uuid)
    if (!shouldApply(local, rec)) return false
    const deleted = rec.deleted ? 1 : 0
    const values = this.dataColumns.map((c) => rec.data[c] ?? null)
    if (local) {
      const sets = [...this.dataColumns.map((c) => `${c} = ?`), 'updated_at = ?', 'deleted = ?'].join(', ')
      this.db.run(`UPDATE ${this.table} SET ${sets} WHERE uuid = ?`, [...values, rec.updatedAt, deleted, rec.uuid])
    } else {
      const cols = [...this.dataColumns, 'uuid', 'updated_at', 'deleted']
      const placeholders = cols.map(() => '?').join(', ')
      this.db.run(
        `INSERT INTO ${this.table} (${cols.join(', ')}) VALUES (${placeholders})`,
        [...values, rec.uuid, rec.updatedAt, deleted]
      )
    }
    return true
  }

  private metaByUuid(uuid: string): { uuid: string; updatedAt: number; deleted: boolean } | null {
    const stmt = this.db.prepare(`SELECT uuid, updated_at, deleted FROM ${this.table} WHERE uuid = ?`)
    stmt.bind([uuid])
    let meta: { uuid: string; updatedAt: number; deleted: boolean } | null = null
    if (stmt.step()) {
      const o = stmt.getAsObject()
      meta = { uuid: o.uuid as string, updatedAt: o.updated_at as number, deleted: (o.deleted as number) === 1 }
    }
    stmt.free()
    return meta
  }
}

/** The content columns that sync for each collection (local id + audio_path stay local). */
export const SYNC_COLUMNS = {
  transcripts: [
    'created_at',
    'raw_text',
    'cleaned_text',
    'duration_ms',
    'word_count',
    'latency_ms',
    'app_context',
    'model',
    'status'
  ],
  dictionary: ['word', 'misheard', 'source', 'created_at', 'times_applied']
} as const
