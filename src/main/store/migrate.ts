import { randomUUID } from 'node:crypto'
import type { Database } from 'sql.js'

// Schema migration that brings the history + dictionary tables up to sync-readiness:
// adds the sync-identity columns and backfills rows that predate them. Idempotent —
// safe to run on every open. `table` is always an internal constant ('transcripts' /
// 'dictionary'), never user input, so interpolating it into the DDL is safe (mirrors
// the established `${column}` interpolation in history.ts).

const SYNC_COLUMNS: ReadonlyArray<readonly [name: string, decl: string]> = [
  ['uuid', "TEXT NOT NULL DEFAULT ''"],
  ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['deleted', 'INTEGER NOT NULL DEFAULT 0']
]

/** Add the sync columns if missing, then give pre-sync rows a uuid + updated_at. */
export function ensureSyncColumns(db: Database, table: string): void {
  const existing = columnNames(db, table)
  for (const [name, decl] of SYNC_COLUMNS) {
    if (!existing.includes(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`)
  }
  backfill(db, table)
}

function columnNames(db: Database, table: string): string[] {
  const stmt = db.prepare(`PRAGMA table_info(${table})`)
  const names: string[] = []
  while (stmt.step()) names.push(stmt.getAsObject().name as string)
  stmt.free()
  return names
}

/**
 * Stamp a uuid + updated_at on every row that still lacks sync identity. Intentionally
 * runs on every open, not just the first migration: a row without a uuid is a silent sync
 * hole, so this self-heals any that ever slip through. The scan is negligible for a
 * personal-sized history — do not "optimize" it to only-after-ALTER.
 */
function backfill(db: Database, table: string): void {
  const stmt = db.prepare(`SELECT id, created_at FROM ${table} WHERE uuid = '' OR uuid IS NULL`)
  const pending: Array<{ id: number; created_at: number }> = []
  while (stmt.step()) {
    const o = stmt.getAsObject()
    pending.push({ id: o.id as number, created_at: o.created_at as number })
  }
  stmt.free()
  // Stamp strictly-increasing updated_at values in created_at order, so rows that share a
  // created_at don't collide — a tie would let the sync push watermark strand the rest.
  pending.sort((a, b) => a.created_at - b.created_at || a.id - b.id)
  let last = 0
  for (const row of pending) {
    const updatedAt = Math.max(row.created_at, last + 1)
    last = updatedAt
    db.run(`UPDATE ${table} SET uuid = ?, updated_at = ? WHERE id = ?`, [randomUUID(), updatedAt, row.id])
  }
}
