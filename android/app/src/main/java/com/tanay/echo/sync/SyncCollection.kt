package com.tanay.echo.sync

// The local side of one synced collection — the Kotlin analogue of src/main/sync/sync-table.ts
// SyncTable. Room is type-safe, so instead of the desktop's generic ${table} SQL we expose a
// per-collection interface implemented over a typed DAO. The SyncClient only ever talks to this.

/** A local row to push: sync identity + content columns serialized as a JSON payload string. */
data class LocalChange(
    val uuid: String,
    val updatedAt: Long,
    val deleted: Boolean,
    val payload: String
)

interface SyncCollection {
    /** Wire collection name: "transcripts" or "dictionary". */
    val name: String

    /** Local rows changed strictly after `watermark` (a local updatedAt), oldest first,
     * including tombstones. The push side of sync. */
    fun changedSince(watermark: Long): List<LocalChange>

    /**
     * Apply a remote record by uuid, last-write-wins. Returns whether it changed anything.
     * Throws on a malformed/incompatible payload — the SyncClient catches and skips it so one
     * bad peer record can't wedge the whole collection.
     */
    fun applyRemote(uuid: String, updatedAt: Long, deleted: Boolean, payload: String?): Boolean
}
