package com.tanay.echo.sync

// Pure last-write-wins sync semantics — a verbatim Kotlin port of src/shared/sync.ts, the
// single source of truth for "who wins" when two devices change the same row. No I/O, no
// clock reads → unit-testable on a plain JVM (see MergeTest). Desktop, phone, and the tailnet
// service all apply this identical rule, which is what makes the merge idempotent.

/** Sync identity carried by every syncable row (a transcript or a dictionary entry). */
data class SyncMeta(
    val uuid: String,
    val updatedAt: Long, // epoch ms of the last local change — the last-write-wins key
    val deleted: Boolean // tombstone: a delete is a change with deleted = true, so it propagates
)

/**
 * Last-write-wins: accept `incoming` only when we hold no local copy, or the incoming change
 * is strictly newer. Equal timestamps are the same version and are skipped, so re-pulling a
 * record is idempotent. Tombstones are ordinary records ranked purely by `updatedAt`.
 */
fun shouldApply(local: SyncMeta?, incoming: SyncMeta): Boolean {
    if (local == null) return true
    return incoming.updatedAt > local.updatedAt
}

/** Advance a pull cursor past a batch of server seqs, never moving it backwards. */
fun advanceCursor(current: Long, seqs: List<Long>): Long {
    var next = current
    for (seq in seqs) if (seq > next) next = seq
    return next
}
