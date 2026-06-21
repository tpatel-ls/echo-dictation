package com.tanay.echo.sync

import com.tanay.echo.transcription.joinUrl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class SyncException(message: String) : Exception(message)

/**
 * Pull/push sync orchestration against the tailnet sync service — a faithful port of
 * src/main/sync/client.ts. Per collection: pull (GET since cursor → applyRemote each, with a
 * per-record try/catch so one malformed peer record is skipped, not fatal; cursor persisted per
 * drained page) then push (changedSince → POST, watermark advanced to the max pushed updatedAt).
 * Per-collection isolation: one collection failing doesn't starve the other.
 */
class SyncClient(
    private val collections: List<SyncCollection>,
    private val baseUrl: String,
    private val token: String,
    private val state: SyncState,
    private val httpClient: OkHttpClient = OkHttpClient(),
    private val pageSize: Int = 200
) {
    private val json = Json { ignoreUnknownKeys = true }

    /** One full reconciliation: pull then push for every collection. */
    suspend fun syncOnce() {
        var firstError: Exception? = null
        for (c in collections) {
            try {
                pull(c)
                push(c)
            } catch (e: Exception) {
                // Isolate collections: a failure in one must not starve the others this pass.
                if (firstError == null) firstError = e
            }
        }
        firstError?.let { throw it }
    }

    private suspend fun pull(c: SyncCollection) = withContext(Dispatchers.IO) {
        var cursor = state.getCursor(c.name)
        while (true) {
            val url = joinUrl(baseUrl, "sync/${c.name}") + "?since=$cursor&limit=$pageSize"
            val req = Request.Builder().url(url).header("Authorization", "Bearer $token").get().build()
            val body = httpClient.newCall(req).execute().use { res ->
                if (!res.isSuccessful) throw SyncException("pull ${c.name} failed: ${res.code}")
                json.decodeFromString<PullResponse>(res.body?.string() ?: "")
            }
            for (rec in body.records) {
                try {
                    c.applyRemote(rec.uuid, rec.updatedAt, rec.deleted, rec.payload)
                } catch (e: Exception) {
                    // A malformed/incompatible record (e.g. a future peer schema skew) must not
                    // wedge sync. Skip it; the cursor still advances past it, so it isn't re-pulled.
                    System.err.println("[sync] skipping bad ${c.name} record ${rec.uuid}: ${e.message}")
                }
            }
            cursor = advanceCursor(cursor, body.records.map { it.seq })
            state.setCursor(c.name, cursor) // persist progress per drained page
            if (!body.hasMore) break
        }
    }

    private suspend fun push(c: SyncCollection) = withContext(Dispatchers.IO) {
        val watermark = state.getWatermark(c.name)
        val changes = c.changedSince(watermark)
        if (changes.isEmpty()) return@withContext
        val records = changes.map { WireRecord(it.uuid, it.updatedAt, it.deleted, it.payload) }
        val reqBody = json.encodeToString(PushBody(records)).toRequestBody(JSON_MEDIA)
        val req = Request.Builder()
            .url(joinUrl(baseUrl, "sync/${c.name}"))
            .header("Authorization", "Bearer $token")
            .post(reqBody)
            .build()
        httpClient.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw SyncException("push ${c.name} failed: ${res.code}")
        }
        // Advance the watermark to the newest pushed updatedAt (safe: the desktop monotonic clock
        // guarantees unique updated_at, so strict `>` in changedSince can't strand a same-ms write).
        val highest = changes.fold(watermark) { max, ch -> maxOf(max, ch.updatedAt) }
        state.setWatermark(c.name, highest)
    }

    private companion object {
        private val JSON_MEDIA = "application/json".toMediaType()
    }
}
