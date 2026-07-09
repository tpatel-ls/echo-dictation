package com.tanay.echo.transcription

import org.junit.Assert.assertEquals
import org.junit.Test

/** Mirrors tests/voice-commands.test.ts — the desktop and Android transforms must agree exactly. */
class VoiceCommandsTest {
    @Test
    fun `new paragraph becomes a blank line`() {
        assertEquals(
            "Thanks for the update.\n\nI will review it tomorrow.",
            applyVoiceCommands("Thanks for the update. New paragraph. I will review it tomorrow."),
        )
    }

    @Test
    fun `leave space and leave a space become a blank line`() {
        assertEquals(
            "First point here\n\nSecond point here",
            applyVoiceCommands("First point here leave space second point here"),
        )
        assertEquals(
            "Hello team,\n\nThe launch is on Friday.",
            applyVoiceCommands("Hello team, leave a space, the launch is on Friday."),
        )
    }

    @Test
    fun `new line and next line become a single line break`() {
        assertEquals("Best regards\nTanay", applyVoiceCommands("Best regards new line Tanay"))
        assertEquals("Item one,\nItem two.", applyVoiceCommands("Item one, next line, item two."))
    }

    @Test
    fun `whisper punctuation around the command is absorbed`() {
        assertEquals(
            "Sounds good.\n\nLet me know if that works.",
            applyVoiceCommands("Sounds good. New paragraph, let me know if that works."),
        )
    }

    @Test
    fun `case-insensitive and multiple commands in one dictation`() {
        assertEquals(
            "Hi Bryan\n\nThe report is ready\n\nThanks\nTanay",
            applyVoiceCommands("Hi Bryan new paragraph the report is ready NEW PARAGRAPH thanks new line Tanay"),
        )
    }

    @Test
    fun `phrase preceded by an article stays literal content`() {
        assertEquals(
            "Please add a new paragraph about pricing to the doc.",
            applyVoiceCommands("Please add a new paragraph about pricing to the doc."),
        )
        assertEquals(
            "The new line of products ships in May.",
            applyVoiceCommands("The new line of products ships in May."),
        )
    }

    @Test
    fun `dangling spaces trimmed and next word capitalized`() {
        assertEquals(
            "okay,\n\nSo the next thing is testing",
            applyVoiceCommands("okay, new paragraph, so the next thing is testing"),
        )
    }

    @Test
    fun `command at the very start or end leaves no stray breaks`() {
        assertEquals("Hello there.", applyVoiceCommands("New paragraph. Hello there."))
        assertEquals("Hello there.", applyVoiceCommands("Hello there. New paragraph."))
    }

    @Test
    fun `text without commands passes through untouched`() {
        assertEquals("Just a normal sentence.", applyVoiceCommands("Just a normal sentence."))
        assertEquals("", applyVoiceCommands(""))
    }
}
