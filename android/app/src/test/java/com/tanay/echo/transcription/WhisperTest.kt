package com.tanay.echo.transcription

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

// Mirrors tests/whisper.test.ts. parseWhisperText/joinUrl are pure; the retry/timeout policy
// is exercised against MockWebServer — all on a plain JVM. `retryOnConnectionFailure(false)`
// makes OUR retry loop the thing under test (OkHttp won't silently retry the disconnect).
// `sleep` is a no-op so there are no real backoff waits. Runs via `./gradlew test`.
class WhisperTest {
    private lateinit var server: MockWebServer
    private val client = WhisperClient(
        httpClient = OkHttpClient.Builder().retryOnConnectionFailure(false).build(),
        sleep = { /* no real backoff in tests */ }
    )

    // Pin to 127.0.0.1: "localhost" resolves to both ::1 and 127.0.0.1, the server binds only one,
    // and with retryOnConnectionFailure(false) OkHttp won't fall back to the second address — so the
    // disconnect test's retry would die on the unbound address instead of reaching the server.
    private fun base() = "http://127.0.0.1:${server.port}/v1"

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun prewarmPingsTheOriginHealthEndpointAndSwallowsFailures() {
        server.enqueue(MockResponse().setResponseCode(404).setBody("nope"))
        client.prewarm(base())
        val req = server.takeRequest(2, java.util.concurrent.TimeUnit.SECONDS)
        assertEquals("/health", req?.path)
        assertEquals("GET", req?.method)
        client.prewarm("") // invalid URL — must not throw
        client.prewarm("not a url")
    }

    @Test
    fun joinUrlJoinsWithoutDoubleSlashes() {
        assertEquals("https://w/v1/audio/transcriptions", joinUrl("https://w/v1/", "/audio/transcriptions"))
        assertEquals("https://w/v1/audio/transcriptions", joinUrl("https://w/v1", "audio/transcriptions"))
    }

    @Test
    fun parseTrimsHandlesMissingAndIgnoresUnknownKeys() {
        assertEquals("hi", parseWhisperText("""{"text":"  hi  "}"""))
        assertEquals("", parseWhisperText("""{}"""))
        assertEquals("x", parseWhisperText("""{"text":"x","language":"en"}"""))
    }

    @Test
    fun postsMultipartAndReturnsTrimmedText() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"text":"  hello world  "}"""))
        val out = client.transcribe(ByteArray(8), base(), "whisper-1", "KEY")
        assertEquals("hello world", out)
        val req = server.takeRequest()
        assertEquals("Bearer KEY", req.getHeader("Authorization"))
        val body = req.body.readUtf8()
        assertTrue(body.contains("name=\"model\""))
        assertTrue(body.contains("whisper-1"))
    }

    @Test
    fun retriesTransientNetworkFailureThenSucceeds() = runTest {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"text":"recovered"}"""))
        // Returning "recovered" proves the first (failed) attempt was retried into the second.
        assertEquals("recovered", client.transcribe(ByteArray(8), base(), "whisper-1", "KEY"))
    }

    @Test
    fun retriesOn5xxAndGivesUp() = runTest {
        repeat(3) { server.enqueue(MockResponse().setResponseCode(503).setBody("boom")) }
        try {
            client.transcribe(ByteArray(8), base(), "whisper-1", "KEY", retries = 2)
            fail("expected TranscriptionException")
        } catch (e: TranscriptionException) {
            // expected
        }
        assertEquals(3, server.requestCount) // initial + 2 retries
    }

    @Test
    fun doesNotRetry4xxClientError() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("bad key"))
        try {
            client.transcribe(ByteArray(8), base(), "whisper-1", "KEY")
            fail("expected TranscriptionException")
        } catch (e: TranscriptionException) {
            // expected
        }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun includesBiasPromptWhenProvided() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"text":"ok"}"""))
        client.transcribe(ByteArray(8), base(), "whisper-1", "KEY", prompt = "Bryan, Tanay")
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("name=\"prompt\""))
        assertTrue(body.contains("Bryan, Tanay"))
    }

    @Test
    fun omitsPromptWhenNotProvided() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"text":"ok"}"""))
        client.transcribe(ByteArray(8), base(), "whisper-1", "KEY")
        assertFalse(server.takeRequest().body.readUtf8().contains("name=\"prompt\""))
    }

    @Test
    fun retriesWithoutPromptWhenServerRejectsItWith4xx() = runTest {
        server.enqueue(MockResponse().setResponseCode(400).setBody("unknown field: prompt"))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"text":"ok"}"""))
        val out = client.transcribe(ByteArray(8), base(), "whisper-1", "KEY", prompt = "Bryan")
        assertEquals("ok", out)
        assertTrue(server.takeRequest().body.readUtf8().contains("name=\"prompt\"")) // first: with prompt
        assertFalse(server.takeRequest().body.readUtf8().contains("name=\"prompt\"")) // retry: without
    }

    @Test
    fun languageParamNormalizesAutoAndBlankToNull() {
        assertNull(languageParam(""))
        assertNull(languageParam("   "))
        assertNull(languageParam("auto"))
        assertNull(languageParam(" AUTO "))
        assertEquals("en", languageParam(" EN "))
        assertEquals("hi", languageParam("hi"))
    }

    @Test
    fun includesLanguageWhenSet() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"text":"ok"}"""))
        client.transcribe(ByteArray(8), base(), "whisper-1", "KEY", language = "es")
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("name=\"language\""))
        assertTrue(body.contains("es"))
    }

    @Test
    fun omitsLanguageWhenNull() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"text":"ok"}"""))
        client.transcribe(ByteArray(8), base(), "whisper-1", "KEY")
        assertFalse(server.takeRequest().body.readUtf8().contains("name=\"language\""))
    }

    @Test
    fun wrapsNetworkErrorsAsTranscriptionException() = runTest {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        try {
            client.transcribe(ByteArray(8), base(), "whisper-1", "KEY", retries = 0)
            fail("expected TranscriptionException")
        } catch (e: TranscriptionException) {
            assertTrue(e.message!!.contains("Network error"))
        }
    }
}
