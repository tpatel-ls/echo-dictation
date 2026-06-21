package com.tanay.echo.transcription

import org.junit.Assert.assertEquals
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
}
