package com.tanay.echo.sync

import android.content.SharedPreferences

// Per-collection sync progress: a server-seq pull cursor and a local-updatedAt push watermark,
// mirroring src/main/sync/client.ts SyncState. Persistence is the caller's concern.

interface SyncState {
    fun getCursor(collection: String): Long
    fun setCursor(collection: String, cursor: Long)
    fun getWatermark(collection: String): Long
    fun setWatermark(collection: String, watermark: Long)
}

/** In-memory state — the default for tests and a base for persistence. */
class InMemorySyncState : SyncState {
    private val cursors = HashMap<String, Long>()
    private val watermarks = HashMap<String, Long>()
    override fun getCursor(collection: String) = cursors[collection] ?: 0
    override fun setCursor(collection: String, cursor: Long) {
        cursors[collection] = cursor
    }
    override fun getWatermark(collection: String) = watermarks[collection] ?: 0
    override fun setWatermark(collection: String, watermark: Long) {
        watermarks[collection] = watermark
    }
}

/** SharedPreferences-backed state for the app — survives keyboard/process restarts. Sync
 * progress is an optimization, never a source of truth, so a cleared prefs file just re-pulls
 * from 0 (idempotent). */
class PrefsSyncState(private val prefs: SharedPreferences) : SyncState {
    override fun getCursor(collection: String) = prefs.getLong("cursor.$collection", 0)
    override fun setCursor(collection: String, cursor: Long) {
        prefs.edit().putLong("cursor.$collection", cursor).apply()
    }
    override fun getWatermark(collection: String) = prefs.getLong("watermark.$collection", 0)
    override fun setWatermark(collection: String, watermark: Long) {
        prefs.edit().putLong("watermark.$collection", watermark).apply()
    }
}
