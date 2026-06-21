import type { Database, SqlValue } from 'sql.js'
import { shouldApply } from '../shared/sync'

// ─────────────────────────────────────────────────────────────────────────────
// Server-side sync store. One table holds every collection's rows keyed by
// (collection, uuid). `payload` is an opaque JSON string — the service never looks
// inside it, so the same store serves transcripts, dictionary, and anything later.
// `seq` is a globally monotonic counter (max+1 per applied write) that gives clients
// a clock-independent pull cursor. Conflict resolution defers to the shared
// last-write-wins rule so desktop, phone, and server can never disagree on a winner.
// ─────────────────────────────────────────────────────────────────────────────

/** A request to store one record (the wire envelope, payload pre-serialized). */
export interface UpsertInput {
  uuid: string
  updatedAt: number
  deleted: boolean
  /** Serialized row JSON; null or omitted for a tombstone. */
  payload?: string | null
}

/** A stored record as handed back to clients on pull. */
export interface SyncRecord {
  uuid: string
  updatedAt: number
  deleted: boolean
  payload: string | null
  seq: number
}

export interface SinceResult {
  records: SyncRecord[]
  cursor: number
  hasMore: boolean
}

export interface UpsertResult {
  applied: boolean
  /** The record's current seq (the new one if applied, the existing one if skipped). */
  seq: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL,
  uuid TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  seq INTEGER NOT NULL,
  PRIMARY KEY (collection, uuid)
);
CREATE INDEX IF NOT EXISTS idx_records_seq ON records(collection, seq);
`

export class SyncStore {
  constructor(
    private db: Database,
    private onChange: () => void = () => {}
  ) {
    this.db.run(SCHEMA)
  }

  /** Last-write-wins upsert. Applies `input` only if newer than the stored row. */
  upsert(collection: string, input: UpsertInput): UpsertResult {
    const existing = this.find(collection, input.uuid)
    if (!shouldApply(existing, input)) {
      return { applied: false, seq: existing ? existing.seq : 0 }
    }
    const seq = this.nextSeq(collection)
    const deleted = input.deleted ? 1 : 0
    // sql.js cannot bind `undefined`; an omitted payload (from deserialized JSON) is a tombstone.
    const payload = input.payload ?? null
    if (existing) {
      this.db.run(
        'UPDATE records SET updated_at=?, deleted=?, payload=?, seq=? WHERE collection=? AND uuid=?',
        [input.updatedAt, deleted, payload, seq, collection, input.uuid]
      )
    } else {
      this.db.run(
        'INSERT INTO records (collection, uuid, updated_at, deleted, payload, seq) VALUES (?,?,?,?,?,?)',
        [collection, input.uuid, input.updatedAt, deleted, payload, seq]
      )
    }
    this.onChange()
    return { applied: true, seq }
  }

  /** Records in `collection` with seq greater than `cursor`, oldest first, capped at `limit`. */
  since(collection: string, cursor: number, limit: number): SinceResult {
    // Floor to at least 1 so a degenerate limit can't return an empty page with
    // hasMore=true and a frozen cursor — which would loop a paginating client forever.
    const lim = limit >= 1 ? Math.floor(limit) : 1
    const rows = this.query(
      'SELECT * FROM records WHERE collection=? AND seq>? ORDER BY seq ASC LIMIT ?',
      [collection, cursor, lim + 1]
    )
    const hasMore = rows.length > lim
    const records = hasMore ? rows.slice(0, lim) : rows
    const newCursor = records.length ? records[records.length - 1].seq : cursor
    return { records, cursor: newCursor, hasMore }
  }

  private find(collection: string, uuid: string): SyncRecord | null {
    return this.query('SELECT * FROM records WHERE collection=? AND uuid=?', [collection, uuid])[0] ?? null
  }

  private nextSeq(collection: string): number {
    // Per-collection monotonic counter — matches the design spec and the (collection, seq) index.
    return this.scalar('SELECT COALESCE(MAX(seq),0)+1 FROM records WHERE collection=?', [collection])
  }

  private query(sql: string, params: SqlValue[]): SyncRecord[] {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const rows: SyncRecord[] = []
    while (stmt.step()) rows.push(toRecord(stmt.getAsObject()))
    stmt.free()
    return rows
  }

  private scalar(sql: string, params: SqlValue[]): number {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    let v = 0
    if (stmt.step()) v = (stmt.get()[0] as number) ?? 0
    stmt.free()
    return v
  }
}

function toRecord(o: Record<string, SqlValue>): SyncRecord {
  return {
    uuid: o.uuid as string,
    updatedAt: o.updated_at as number,
    deleted: (o.deleted as number) === 1,
    payload: (o.payload as string | null) ?? null,
    seq: o.seq as number
  }
}
