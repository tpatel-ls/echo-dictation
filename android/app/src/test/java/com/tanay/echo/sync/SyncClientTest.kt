package com.tanay.echo.sync

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

// Exercises the SyncClient orchestration against MockWebServer with an in-memory fake collection
// — mirrors the client-layer behaviors of tests/sync-client.test.ts (pull applies, push sends
// changes + advances watermark, poison-pill skip, auth failure, pagination). The full
// bidirectional loop is covered desktop-side; here we prove the Kotlin port behaves the same.
// Runs on a plain JVM via `./gradlew test`.
class SyncClientTest {
    private lateinit var server: MockWebServer
    private val http = OkHttpClient()
    private val wire = Json { ignoreUnknownKeys = true }

    private fun base() = server.url("/").toString()
    private fun stored(uuid: String, updatedAt: Long, seq: Long) =
        StoredRecord(uuid, updatedAt, false, "{}", seq)
    private fun pull(resp: PullResponse) = MockResponse().setResponseCode(200).setBody(wire.encodeToString(resp))
    private fun pushOk(applied: Int) = MockResponse().setResponseCode(200).setBody(wire.encodeToString(PushResponse(applied)))

    /** A local collection backed by memory: records applied uuids, can be told to push some
     * changes or to throw on a specific uuid (the poison-pill case). */
    private class FakeCollection(
        override val name: String,
        private val toPush: List<LocalChange> = emptyList(),
        private val throwOnUuid: String? = null
    ) : SyncCollection {
        val applied = mutableListOf<String>()
        override fun changedSince(watermark: Long) = toPush.filter { it.updatedAt > watermark }
        override fun applyRemote(uuid: String, updatedAt: Long, deleted: Boolean, payload: String?): Boolean {
            if (uuid == throwOnUuid) throw IllegalStateException("malformed payload")
            applied.add(uuid)
            return true
        }
    }

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun pullAppliesRemoteRecordsAndPersistsCursor() = runTest {
        val col = FakeCollection("transcripts")
        val state = InMemorySyncState()
        server.enqueue(pull(PullResponse(listOf(stored("u1", 100, 1)), cursor = 1, hasMore = false)))
        SyncClient(listOf(col), base(), "tok", state, http).syncOnce()
        assertEquals(listOf("u1"), col.applied)
        assertEquals(1L, state.getCursor("transcripts"))
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        assertTrue(req.path!!.startsWith("/sync/transcripts?since=0&limit=200"))
    }

    @Test
    fun pushSendsLocalChangesAndAdvancesWatermark() = runTest {
        val col = FakeCollection("transcripts", toPush = listOf(LocalChange("l1", 500, false, """{"raw_text":"x"}""")))
        val state = InMemorySyncState()
        server.enqueue(pull(PullResponse(emptyList(), cursor = 0, hasMore = false)))
        server.enqueue(pushOk(1))
        SyncClient(listOf(col), base(), "tok", state, http).syncOnce()
        server.takeRequest() // GET pull
        val post = server.takeRequest()
        assertEquals("POST", post.method)
        val body = post.body.readUtf8()
        assertTrue(body.contains("l1"))
        assertTrue(body.contains("raw_text")) // the payload JSON string is embedded
        assertEquals(500L, state.getWatermark("transcripts"))
    }

    @Test
    fun skipsRecordWhoseApplyThrowsAndAdvancesPastIt() = runTest {
        val col = FakeCollection("transcripts", throwOnUuid = "bad")
        val state = InMemorySyncState()
        server.enqueue(pull(PullResponse(listOf(stored("bad", 100, 1), stored("good", 200, 2)), cursor = 2, hasMore = false)))
        SyncClient(listOf(col), base(), "tok", state, http).syncOnce() // must not throw
        assertEquals(listOf("good"), col.applied)
        assertEquals(2L, state.getCursor("transcripts"))
    }

    @Test
    fun authFailureThrowsSyncException() = runTest {
        val col = FakeCollection("transcripts")
        server.enqueue(MockResponse().setResponseCode(401).setBody("unauthorized"))
        try {
            SyncClient(listOf(col), base(), "tok", InMemorySyncState(), http).syncOnce()
            fail("expected SyncException")
        } catch (e: SyncException) {
            assertTrue(e.message!!.contains("failed"))
        }
    }

    @Test
    fun paginatesThroughHasMore() = runTest {
        val col = FakeCollection("transcripts")
        val state = InMemorySyncState()
        server.enqueue(pull(PullResponse(listOf(stored("a", 10, 1), stored("b", 20, 2)), cursor = 2, hasMore = true)))
        server.enqueue(pull(PullResponse(listOf(stored("c", 30, 3)), cursor = 3, hasMore = false)))
        SyncClient(listOf(col), base(), "tok", state, http).syncOnce()
        assertEquals(listOf("a", "b", "c"), col.applied)
        assertEquals(3L, state.getCursor("transcripts"))
        server.takeRequest() // page 1 (since=0)
        assertTrue(server.takeRequest().path!!.contains("since=2")) // page 2 used the advanced cursor
    }
}
