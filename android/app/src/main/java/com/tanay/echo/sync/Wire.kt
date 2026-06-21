package com.tanay.echo.sync

import kotlinx.serialization.Serializable

// The sync wire format (shared with the desktop + service). `payload` is a JSON string of the
// collection's content columns (snake_case keys matching the desktop SYNC_COLUMNS), so a phone
// and a desktop interoperate byte-for-byte. The server is payload-agnostic.

/** One record as pushed (no server seq yet). payload is null on a tombstone. */
@Serializable
data class WireRecord(
    val uuid: String,
    val updatedAt: Long,
    val deleted: Boolean,
    val payload: String?
)

/** One record as returned by a pull — a WireRecord plus the server's monotonic seq. */
@Serializable
data class StoredRecord(
    val uuid: String,
    val updatedAt: Long,
    val deleted: Boolean,
    val payload: String?,
    val seq: Long
)

/** GET /sync/:collection?since=&limit= response. */
@Serializable
data class PullResponse(
    val records: List<StoredRecord>,
    val cursor: Long,
    val hasMore: Boolean
)

/** POST /sync/:collection body. */
@Serializable
data class PushBody(val records: List<WireRecord>)

/** POST /sync/:collection response (a count, never a cursor — clients only advance the pull
 * cursor from pull responses). */
@Serializable
data class PushResponse(val applied: Int)
