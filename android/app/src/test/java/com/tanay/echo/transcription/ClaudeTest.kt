package com.tanay.echo.transcription

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Pure-parse coverage for the optional Claude cleanup (mirrors the content[].text extraction in
// src/main/transcription/claude.ts). Runs on a plain JVM via `./gradlew test`.
class ClaudeTest {
    @Test
    fun extractsTextBlock() {
        assertEquals("Hello world", parseClaudeText("""{"content":[{"type":"text","text":"Hello world"}]}""", "raw"))
    }

    @Test
    fun joinsMultipleTextBlocksAndTrims() {
        val body = """{"content":[{"type":"text","text":"a "},{"type":"text","text":"b "}]}"""
        assertEquals("a b", parseClaudeText(body, "raw"))
    }

    @Test
    fun fallsBackToInputWhenNoText() {
        assertEquals("raw", parseClaudeText("""{"content":[]}""", "raw"))
        assertEquals("raw", parseClaudeText("""{"content":[{"type":"image"}]}""", "raw"))
    }

    // buildCleanupSystem layers: base instructions → pinned glossary → optional per-app style line.

    @Test
    fun `base system prompt has no vocabulary or style line`() {
        val s = buildCleanupSystem(emptyList(), null)
        assertTrue(s.contains("clean up raw speech-to-text", ignoreCase = true))
        assertFalse(s.contains("custom vocabulary", ignoreCase = true))
    }

    @Test
    fun `glossary is pinned into the system prompt`() {
        val s = buildCleanupSystem(listOf("GitHub", "Tanay"), null)
        assertTrue(s.contains("custom vocabulary", ignoreCase = true))
        assertTrue(s.contains("GitHub"))
        assertTrue(s.contains("Tanay"))
    }

    @Test
    fun `style directive is appended when present`() {
        val s = buildCleanupSystem(emptyList(), "Make it formal.")
        assertTrue(s.contains("Make it formal."))
    }

    @Test
    fun `glossary comes before the style directive`() {
        val s = buildCleanupSystem(listOf("GitHub"), "Make it formal.")
        assertTrue(s.indexOf("GitHub") < s.indexOf("Make it formal."))
    }

    // Command Mode prompt building.

    @Test
    fun `command system prompt describes an in-place editor`() {
        val s = buildCommandSystem(emptyList())
        assertTrue(s.contains("editor", ignoreCase = true))
        assertFalse(s.contains("custom vocabulary", ignoreCase = true))
    }

    @Test
    fun `command system pins the glossary`() {
        val s = buildCommandSystem(listOf("GitHub"))
        assertTrue(s.contains("custom vocabulary", ignoreCase = true))
        assertTrue(s.contains("GitHub"))
    }

    @Test
    fun `command user message carries the instruction and the text`() {
        val u = buildCommandUser("make it formal", "hey whats up")
        assertTrue(u.contains("make it formal"))
        assertTrue(u.contains("hey whats up"))
    }
}
