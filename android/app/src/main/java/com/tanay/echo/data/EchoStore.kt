package com.tanay.echo.data

import com.tanay.echo.dictionary.DictionaryEntry
import com.tanay.echo.sync.SyncCollection
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.UUID

private val aliasJson = Json { ignoreUnknownKeys = true }
private val whitespace = Regex("\\s+")

/**
 * The IME's view of the local database — the Android analogue of the desktop HistoryStore +
 * DictionaryStore. Stamps a uuid + a unique monotonic updatedAt on every local write (so the
 * sync push watermark's strict `>` is safe), soft-deletes, and exposes the dictionary as domain
 * entries for the bias prompt + replacement layer. All methods block — call them off the main
 * thread (the IME runs them inside Dispatchers.IO).
 */
class EchoStore(
    db: EchoDatabase,
    private val clock: MonotonicClock = MonotonicClock()
) {
    private val transcripts = db.transcripts()
    private val dictionary = db.dictionary()

    /** Persist a finished dictation. Returns the new row id. */
    fun addTranscript(
        rawText: String,
        cleanedText: String?,
        durationMs: Long,
        wordCount: Int,
        latencyMs: Long,
        appContext: String,
        model: String,
        status: String,
        createdAt: Long = System.currentTimeMillis()
    ): Long = transcripts.insert(
        TranscriptEntity(
            uuid = UUID.randomUUID().toString(),
            updatedAt = clock.now(),
            deleted = false,
            createdAt = createdAt,
            rawText = rawText,
            cleanedText = cleanedText,
            durationMs = durationMs,
            wordCount = wordCount,
            latencyMs = latencyMs,
            appContext = appContext,
            model = model,
            status = status
        )
    )

    fun recentTranscripts(limit: Int = 50): List<TranscriptEntity> = transcripts.recent(limit, 0)

    fun softDeleteTranscript(id: Long) = transcripts.softDelete(id, clock.now())

    /** The active dictionary as domain entries (misheard parsed) for bias + replacement. */
    fun dictionaryEntries(): List<DictionaryEntry> = dictionary.active().map { e ->
        DictionaryEntry(
            id = e.id,
            word = e.word,
            misheard = parseAliases(e.misheard),
            source = e.source,
            createdAt = e.createdAt,
            timesApplied = e.timesApplied
        )
    }

    /** Bump times_applied for the entries that fired on the last transcript (drives bias order). */
    fun recordApplied(ids: List<Long>) {
        if (ids.isEmpty()) return
        val ts = clock.now()
        for (id in ids) dictionary.bumpApplied(id, ts)
    }

    /** Add a word, or merge aliases into an existing active one (mirrors the desktop merge). */
    fun addWord(word: String, misheard: List<String>, source: String = "manual"): Long {
        val w = word.trim().replace(whitespace, " ")
        require(w.isNotEmpty()) { "A dictionary word is required" }
        val ts = clock.now()
        val existing = dictionary.activeByWord(w)
        if (existing != null) {
            val merged = normalizeAliases(parseAliases(existing.misheard) + misheard, w)
            dictionary.update(existing.copy(misheard = aliasJson.encodeToString(merged), updatedAt = ts))
            return existing.id
        }
        return dictionary.insert(
            DictionaryEntity(
                uuid = UUID.randomUUID().toString(),
                updatedAt = ts,
                deleted = false,
                word = w,
                misheard = aliasJson.encodeToString(normalizeAliases(misheard, w)),
                source = source,
                createdAt = System.currentTimeMillis(),
                timesApplied = 0
            )
        )
    }

    /** The sync collections to hand a SyncClient. */
    fun syncCollections(): List<SyncCollection> = listOf(
        TranscriptSyncCollection(transcripts),
        DictionarySyncCollection(dictionary)
    )

    private fun parseAliases(jsonArray: String): List<String> =
        try {
            aliasJson.decodeFromString<List<String>>(jsonArray)
        } catch (e: Exception) {
            emptyList()
        }

    private fun normalizeAliases(aliases: List<String>, word: String): List<String> =
        aliases.map { it.trim().replace(whitespace, " ") }
            .filter { it.isNotEmpty() && !it.equals(word, ignoreCase = true) }
            .distinctBy { it.lowercase() }
}
