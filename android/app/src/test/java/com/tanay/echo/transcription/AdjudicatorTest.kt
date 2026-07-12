package com.tanay.echo.transcription

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class AdjudicatorTest {
    private lateinit var server: MockWebServer

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
    fun parsesResponsesApiOutput() {
        val body = """{"output":[{"type":"message","content":[{"type":"output_text","text":"How is it going?"}]}]}"""
        assertEquals("How is it going?", parseResponsesText(body))
    }

    @Test
    fun sendsCandidatesAsAsrHypothesesAndReturnsOnlyCleanEnglish() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"output":[{"content":[{"type":"output_text","text":"How is it going today?"}]}]}""",
            ),
        )
        val client = AdjudicatorClient(OkHttpClient())
        val result = client.adjudicate(
            candidates = listOf(
                TranscriptCandidate(CandidateSource.REMOTE_PRIMARY, "How is it going today?", 90),
                TranscriptCandidate(CandidateSource.REMOTE_RECOVERY, "How's it going today?", 110),
            ),
            appContext = "com.example.notes",
            glossary = listOf("Tanay"),
            baseUrl = server.url("/proxy/").toString(),
            models = listOf("gpt-5.4-mini"),
            apiKey = "KEY",
        )

        assertEquals("How is it going today?", result)
        val request = server.takeRequest()
        assertEquals("Bearer KEY", request.getHeader("Authorization"))
        assertEquals("/proxy/v1/responses", request.path)
        val payload = request.body.readUtf8()
        assertTrue(payload.contains("definitely speaking English"))
        assertTrue(payload.contains("How's it going today?"))
        assertTrue(payload.contains("Tanay"))
    }
}
