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

    // stripEmDashes mirrors tests/claude.test.ts — no em dash may ever reach inserted text.

    @Test
    fun stripsSpacedAndUnspacedEmDashesToCommas() {
        assertEquals(
            "The report, which Bryan sent, is ready.",
            stripEmDashes("The report — which Bryan sent — is ready."),
        )
        assertEquals("Revenue is up, nice work.", stripEmDashes("Revenue is up—nice work."))
    }

    @Test
    fun collapsesEmDashAfterPunctuation() {
        assertEquals("Ready, thanks", stripEmDashes("Ready, — thanks"))
        assertEquals("Done: next steps below", stripEmDashes("Done: — next steps below"))
    }

    @Test
    fun lineLeadingEmDashBecomesHyphenBullet() {
        assertEquals("- first item\n- second item", stripEmDashes("— first item\n— second item"))
    }

    @Test
    fun leavesTextWithoutEmDashesUntouched() {
        assertEquals("Plain text, with commas - and a hyphen.", stripEmDashes("Plain text, with commas - and a hyphen."))
    }

    @Test
    fun parseScrubsEmDashesFromModelOutput() {
        val body = """{"content":[{"type":"text","text":"Numbers look good — see attached."}]}"""
        assertEquals("Numbers look good, see attached.", parseClaudeText(body, "raw"))
    }

    // stripWrapper mirrors tests/claude.test.ts — no lead-in or separator may reach inserted text.

    @Test
    fun stripsLeadInLineAndSeparators() {
        assertEquals(
            "The next steps are done.",
            stripWrapper("Here is the cleaned transcript:\n\nThe next steps are done."),
        )
        assertEquals("Hello.", stripWrapper("Here's the cleaned text:\nHello."))
        assertEquals("The next steps are done.", stripWrapper("---\nThe next steps are done.\n---"))
        assertEquals("Ready to test.", stripWrapper("Here is the cleaned transcript:\n\n---\n\nReady to test."))
    }

    @Test
    fun keepsRealContentStartingWithHereIs() {
        assertEquals("Here is the plan: we ship on Friday.", stripWrapper("Here is the plan: we ship on Friday."))
        assertEquals("Hi everyone,\n\nThe next steps are done.", stripWrapper("Hi everyone,\n\nThe next steps are done."))
    }

    @Test
    fun parseScrubsWrapperFromModelOutput() {
        val body = """{"content":[{"type":"text","text":"Here is the cleaned transcript:\n\n---\n\nDone."}]}"""
        assertEquals("Done.", parseClaudeText(body, "raw"))
    }

    @Test
    fun stripsSeparatorLinesBetweenParagraphsAndSubjectLines() {
        assertEquals(
            "Hi everyone.\n\nThe next steps are done.\n\nWe are ready to test it.",
            stripWrapper("Hi everyone.\n\n---\n\nThe next steps are done.\n\n---\n\nWe are ready to test it."),
        )
        assertEquals("First.\n\nSecond.", stripWrapper("First.\n***\nSecond."))
        assertEquals("Hi Bryan,\n\nNumbers look good.", stripWrapper("Subject: Numbers\n\nHi Bryan,\n\nNumbers look good."))
        assertEquals("The subject: pricing came up.", stripWrapper("The subject: pricing came up."))
        assertEquals("The range is 5-10 items - roughly.", stripWrapper("The range is 5-10 items - roughly."))
    }

    @Test
    fun breakMarkersRoundTripThroughProtectAndRestore() {
        val text = "Hi everyone\n\nThe next steps are done.\nThanks"
        val protectedText = protectBreaks(text)
        assertFalse(protectedText.contains("\n"))
        assertEquals(text, restoreBreaks(protectedText))
        assertEquals("a\n\nb", restoreBreaks("a ⟦PARA⟧b"))
        assertEquals("one line only", protectBreaks("one line only"))
    }

    // needsAiCleanup fast path mirrors tests/format.test.ts.

    @Test
    fun fastPathSkipsShortCleanDictationsOnly() {
        assertFalse(needsAiCleanup("Sounds good, see you tomorrow."))
        assertFalse(needsAiCleanup("On my way!"))
        assertTrue(needsAiCleanup("um sounds good see you tomorrow"))
        assertTrue(needsAiCleanup("Sounds good see you tomorrow")) // no terminal punctuation
        assertTrue(needsAiCleanup("The the report is ready.")) // stutter
        assertTrue(needsAiCleanup("First line.\nSecond line."))
        assertTrue(needsAiCleanup("Write an email to Bryan."))
        assertTrue(needsAiCleanup(""))
        assertTrue(needsAiCleanup("This is a much longer dictation that keeps going and definitely deserves a proper cleanup pass."))
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
