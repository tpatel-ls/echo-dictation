// ─────────────────────────────────────────────────────────────────────────────
// Pure last-write-wins sync semantics, shared by the desktop store, the Android
// client, and the tailnet sync service. No I/O, no clock reads — fully testable, and
// the single source of truth for "who wins" when two devices change the same row.
// ─────────────────────────────────────────────────────────────────────────────

/** Sync identity carried by every syncable row (a transcript or a dictionary entry). */
export interface SyncMeta {
  /** Device-independent identity, generated once at row creation. */
  uuid: string
  /** Epoch ms of the last local change — the last-write-wins key. */
  updatedAt: number
  /** Tombstone: a delete is just a change with `deleted = true`, so it propagates. */
  deleted: boolean
}

/**
 * Last-write-wins: accept `incoming` only when we hold no local copy, or the incoming
 * change is strictly newer. Equal timestamps are the same version and are skipped, so
 * re-pulling a record is idempotent. Tombstones are ordinary records ranked purely by
 * `updatedAt`, so a delete and a later edit resolve naturally by recency.
 */
export function shouldApply(local: SyncMeta | null | undefined, incoming: SyncMeta): boolean {
  if (!local) return true
  return incoming.updatedAt > local.updatedAt
}

/** Advance a pull cursor past a batch of server records, never moving it backwards. */
export function advanceCursor(current: number, batch: ReadonlyArray<{ seq: number }>): number {
  let next = current
  for (const record of batch) if (record.seq > next) next = record.seq
  return next
}
