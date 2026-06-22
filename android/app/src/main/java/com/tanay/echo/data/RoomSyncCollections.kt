package com.tanay.echo.data

import com.tanay.echo.sync.LocalChange
import com.tanay.echo.sync.SyncCollection
import com.tanay.echo.sync.SyncMeta
import com.tanay.echo.sync.shouldApply
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put

// Room-backed SyncCollections — the typed analogue of the desktop's generic SyncTable. The wire
// payload uses the desktop SYNC_COLUMNS snake_case keys verbatim, so a phone and a desktop
// interoperate. applyRemote re-throws on a malformed payload (a missing required key) so the
// SyncClient skips that one record instead of wedging the collection.

private val payloadJson = Json { ignoreUnknownKeys = true }

class TranscriptSyncCollection(private val dao: TranscriptDao) : SyncCollection {
    override val name = "transcripts"

    override fun changedSince(watermark: Long): List<LocalChange> =
        dao.changedSince(watermark).map { e -> LocalChange(e.uuid, e.updatedAt, e.deleted, buildPayload(e)) }

    override fun applyRemote(uuid: String, updatedAt: Long, deleted: Boolean, payload: String?): Boolean {
        val local = dao.metaByUuid(uuid)?.let { SyncMeta(it.uuid, it.updatedAt, it.deleted) }
        if (!shouldApply(local, SyncMeta(uuid, updatedAt, deleted))) return false
        val existing = dao.byUuid(uuid)
        if (payload == null) {
            // A dataless tombstone deletes an existing row without needing content; anything else
            // dataless has nothing to apply. (Desktop tombstones carry their data, so this only
            // fires for a spec-style null-payload delete from another client.)
            if (deleted && existing != null) {
                dao.update(existing.copy(updatedAt = updatedAt, deleted = true))
                return true
            }
            return false
        }
        val obj = payloadJson.parseToJsonElement(payload).jsonObject
        val row = TranscriptEntity(
            id = existing?.id ?: 0,
            uuid = uuid,
            updatedAt = updatedAt,
            deleted = deleted,
            createdAt = obj["created_at"]!!.jsonPrimitive.long,
            rawText = obj["raw_text"]!!.jsonPrimitive.content, // missing ⇒ throws ⇒ record skipped
            cleanedText = obj["cleaned_text"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content,
            durationMs = obj["duration_ms"]!!.jsonPrimitive.long,
            wordCount = obj["word_count"]!!.jsonPrimitive.int,
            latencyMs = obj["latency_ms"]!!.jsonPrimitive.long,
            appContext = obj["app_context"]!!.jsonPrimitive.content,
            model = obj["model"]!!.jsonPrimitive.content,
            status = obj["status"]!!.jsonPrimitive.content
        )
        if (existing != null) dao.update(row) else dao.insert(row)
        return true
    }

    private fun buildPayload(e: TranscriptEntity): String = buildJsonObject {
        put("created_at", e.createdAt)
        put("raw_text", e.rawText)
        put("cleaned_text", e.cleanedText)
        put("duration_ms", e.durationMs)
        put("word_count", e.wordCount)
        put("latency_ms", e.latencyMs)
        put("app_context", e.appContext)
        put("model", e.model)
        put("status", e.status)
    }.toString()
}

class DictionarySyncCollection(private val dao: DictionaryDao) : SyncCollection {
    override val name = "dictionary"

    override fun changedSince(watermark: Long): List<LocalChange> =
        dao.changedSince(watermark).map { e -> LocalChange(e.uuid, e.updatedAt, e.deleted, buildPayload(e)) }

    override fun applyRemote(uuid: String, updatedAt: Long, deleted: Boolean, payload: String?): Boolean {
        val local = dao.metaByUuid(uuid)?.let { SyncMeta(it.uuid, it.updatedAt, it.deleted) }
        if (!shouldApply(local, SyncMeta(uuid, updatedAt, deleted))) return false
        val existing = dao.byUuid(uuid)
        if (payload == null) {
            // A dataless tombstone deletes an existing entry; anything else dataless is a no-op.
            if (deleted && existing != null) {
                dao.update(existing.copy(updatedAt = updatedAt, deleted = true))
                return true
            }
            return false
        }
        val obj = payloadJson.parseToJsonElement(payload).jsonObject
        val row = DictionaryEntity(
            id = existing?.id ?: 0,
            uuid = uuid,
            updatedAt = updatedAt,
            deleted = deleted,
            word = obj["word"]!!.jsonPrimitive.content, // missing ⇒ throws ⇒ record skipped
            misheard = obj["misheard"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content ?: "[]",
            source = obj["source"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content ?: "manual",
            createdAt = obj["created_at"]!!.jsonPrimitive.long,
            timesApplied = obj["times_applied"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.int ?: 0
        )
        if (existing != null) dao.update(row) else dao.insert(row)
        return true
    }

    private fun buildPayload(e: DictionaryEntity): String = buildJsonObject {
        put("word", e.word)
        put("misheard", e.misheard) // already a JSON array string, matching desktop
        put("source", e.source)
        put("created_at", e.createdAt)
        put("times_applied", e.timesApplied)
    }.toString()
}

class SnippetSyncCollection(private val dao: SnippetDao) : SyncCollection {
    override val name = "snippets"

    override fun changedSince(watermark: Long): List<LocalChange> =
        dao.changedSince(watermark).map { e -> LocalChange(e.uuid, e.updatedAt, e.deleted, buildPayload(e)) }

    override fun applyRemote(uuid: String, updatedAt: Long, deleted: Boolean, payload: String?): Boolean {
        val local = dao.metaByUuid(uuid)?.let { SyncMeta(it.uuid, it.updatedAt, it.deleted) }
        if (!shouldApply(local, SyncMeta(uuid, updatedAt, deleted))) return false
        val existing = dao.byUuid(uuid)
        if (payload == null) {
            if (deleted && existing != null) {
                dao.update(existing.copy(updatedAt = updatedAt, deleted = true))
                return true
            }
            return false
        }
        val obj = payloadJson.parseToJsonElement(payload).jsonObject
        val row = SnippetEntity(
            id = existing?.id ?: 0,
            uuid = uuid,
            updatedAt = updatedAt,
            deleted = deleted,
            cue = obj["cue"]!!.jsonPrimitive.content, // missing ⇒ throws ⇒ record skipped
            expansion = obj["expansion"]!!.jsonPrimitive.content,
            createdAt = obj["created_at"]!!.jsonPrimitive.long
        )
        if (existing != null) dao.update(row) else dao.insert(row)
        return true
    }

    private fun buildPayload(e: SnippetEntity): String = buildJsonObject {
        put("cue", e.cue)
        put("expansion", e.expansion)
        put("created_at", e.createdAt)
    }.toString()
}
