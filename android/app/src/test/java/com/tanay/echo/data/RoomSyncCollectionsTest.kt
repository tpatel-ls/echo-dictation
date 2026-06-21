package com.tanay.echo.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

// Unit-tests the REAL TranscriptSyncCollection/DictionarySyncCollection parse + LWW + tombstone
// logic on a plain JVM. The DAOs are interfaces, so we back them with in-memory fakes — no Room,
// no emulator. This exercises the genuine applyRemote/changedSince paths (the poison-pill parse,
// the snake_case payload, dataless-tombstone deletes). Runs via `./gradlew test`.
class RoomSyncCollectionsTest {
    private val validTranscript =
        """{"created_at":2,"raw_text":"fine","cleaned_text":null,"duration_ms":1,"word_count":1,"latency_ms":1,"app_context":"x","model":"m","status":"ok"}"""

    // ── transcripts ──────────────────────────────────────────────────────────

    @Test
    fun applyRemoteInsertsNewRecordFromPayload() {
        val dao = FakeTranscriptDao()
        assertTrue(TranscriptSyncCollection(dao).applyRemote("u1", 100, false, validTranscript))
        val row = dao.byUuid("u1")!!
        assertEquals("fine", row.rawText)
        assertFalse(row.deleted)
    }

    @Test
    fun applyRemoteThrowsOnPayloadMissingRawText() {
        val dao = FakeTranscriptDao()
        val col = TranscriptSyncCollection(dao)
        val bad = """{"created_at":1,"duration_ms":1,"word_count":1,"latency_ms":1,"app_context":"x","model":"m","status":"ok"}"""
        // Missing raw_text ⇒ throws ⇒ the SyncClient's per-record try/catch skips it (poison pill).
        assertThrows(NullPointerException::class.java) { col.applyRemote("bad", 100, false, bad) }
    }

    @Test
    fun applyRemoteSkipsOlderIncoming() {
        val dao = FakeTranscriptDao()
        val col = TranscriptSyncCollection(dao)
        col.applyRemote("u1", 200, false, validTranscript)
        assertFalse(col.applyRemote("u1", 100, false, validTranscript.replace("fine", "stale")))
        assertEquals("fine", dao.byUuid("u1")!!.rawText) // unchanged — last-write-wins
    }

    @Test
    fun tombstoneWithNullPayloadDeletesExistingRow() {
        val dao = FakeTranscriptDao()
        val col = TranscriptSyncCollection(dao)
        col.applyRemote("u1", 100, false, validTranscript)
        assertTrue(col.applyRemote("u1", 200, true, null)) // a dataless tombstone still deletes
        assertTrue(dao.byUuid("u1")!!.deleted)
    }

    @Test
    fun tombstoneWithPayloadDeletesAndKeepsContent() {
        val dao = FakeTranscriptDao()
        val col = TranscriptSyncCollection(dao)
        col.applyRemote("u1", 100, false, validTranscript)
        assertTrue(col.applyRemote("u1", 200, true, validTranscript)) // desktop-style tombstone (carries data)
        val row = dao.byUuid("u1")!!
        assertTrue(row.deleted)
        assertEquals("fine", row.rawText)
    }

    @Test
    fun tombstoneWithNullPayloadForUnseenRowIsNoOp() {
        val dao = FakeTranscriptDao()
        assertFalse(TranscriptSyncCollection(dao).applyRemote("ghost", 200, true, null))
        assertNull(dao.byUuid("ghost"))
    }

    @Test
    fun changedSinceBuildsSnakeCasePayloadOldestFirstIncludingTombstones() {
        val dao = FakeTranscriptDao()
        dao.insert(transcript("a", updatedAt = 10, deleted = false, raw = "hi"))
        dao.insert(transcript("b", updatedAt = 20, deleted = true, raw = "bye"))
        val changes = TranscriptSyncCollection(dao).changedSince(5)
        assertEquals(listOf("a", "b"), changes.map { it.uuid }) // oldest-first, tombstone included
        assertTrue(changes[0].payload.contains("raw_text"))
        assertTrue(changes[0].payload.contains("created_at"))
        assertTrue(changes[1].deleted)
    }

    // ── dictionary ───────────────────────────────────────────────────────────

    @Test
    fun dictionaryApplyRemoteRoundTripsMisheardJsonString() {
        val dao = FakeDictionaryDao()
        val payload = """{"word":"Bryan","misheard":"[\"Brian\"]","source":"manual","created_at":1,"times_applied":0}"""
        DictionarySyncCollection(dao).applyRemote("d1", 100, false, payload)
        assertEquals("""["Brian"]""", dao.byUuid("d1")!!.misheard)
    }

    private fun transcript(uuid: String, updatedAt: Long, deleted: Boolean, raw: String) = TranscriptEntity(
        uuid = uuid, updatedAt = updatedAt, deleted = deleted, createdAt = 1, rawText = raw,
        cleanedText = null, durationMs = 1, wordCount = 1, latencyMs = 1, appContext = "x", model = "m", status = "ok"
    )
}

private class FakeTranscriptDao : TranscriptDao {
    val rows = mutableListOf<TranscriptEntity>()
    private var nextId = 1L
    override fun insert(t: TranscriptEntity): Long {
        val id = nextId++
        rows += t.copy(id = id)
        return id
    }
    override fun update(t: TranscriptEntity) {
        val i = rows.indexOfFirst { it.id == t.id }
        if (i >= 0) rows[i] = t
    }
    override fun recent(limit: Int, offset: Int): List<TranscriptEntity> =
        rows.filter { !it.deleted }
            .sortedWith(compareByDescending<TranscriptEntity> { it.createdAt }.thenByDescending { it.id })
            .drop(offset).take(limit)
    override fun byUuid(uuid: String): TranscriptEntity? = rows.firstOrNull { it.uuid == uuid }
    override fun metaByUuid(uuid: String): SyncMetaRow? =
        byUuid(uuid)?.let { SyncMetaRow(it.uuid, it.updatedAt, it.deleted) }
    override fun changedSince(watermark: Long): List<TranscriptEntity> =
        rows.filter { it.updatedAt > watermark }.sortedWith(compareBy<TranscriptEntity> { it.updatedAt }.thenBy { it.id })
    override fun softDelete(id: Long, updatedAt: Long) {
        val i = rows.indexOfFirst { it.id == id }
        if (i >= 0) rows[i] = rows[i].copy(deleted = true, updatedAt = updatedAt)
    }
}

private class FakeDictionaryDao : DictionaryDao {
    val rows = mutableListOf<DictionaryEntity>()
    private var nextId = 1L
    override fun insert(e: DictionaryEntity): Long {
        val id = nextId++
        rows += e.copy(id = id)
        return id
    }
    override fun update(e: DictionaryEntity) {
        val i = rows.indexOfFirst { it.id == e.id }
        if (i >= 0) rows[i] = e
    }
    override fun active(): List<DictionaryEntity> =
        rows.filter { !it.deleted }
            .sortedWith(compareByDescending<DictionaryEntity> { it.createdAt }.thenByDescending { it.id })
    override fun activeByWord(word: String): DictionaryEntity? =
        rows.firstOrNull { !it.deleted && it.word.equals(word, ignoreCase = true) }
    override fun byUuid(uuid: String): DictionaryEntity? = rows.firstOrNull { it.uuid == uuid }
    override fun metaByUuid(uuid: String): SyncMetaRow? =
        byUuid(uuid)?.let { SyncMetaRow(it.uuid, it.updatedAt, it.deleted) }
    override fun changedSince(watermark: Long): List<DictionaryEntity> =
        rows.filter { it.updatedAt > watermark }.sortedWith(compareBy<DictionaryEntity> { it.updatedAt }.thenBy { it.id })
    override fun bumpApplied(id: Long, updatedAt: Long) {
        val i = rows.indexOfFirst { it.id == id && !it.deleted }
        if (i >= 0) rows[i] = rows[i].copy(timesApplied = rows[i].timesApplied + 1, updatedAt = updatedAt)
    }
}
