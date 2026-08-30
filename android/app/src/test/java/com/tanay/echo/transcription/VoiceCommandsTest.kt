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
    fun `spoken punctuation names become English punctuation`() {
        assertEquals(
            "Meet at seven, not eight. Are you free? Yes!",
            applyVoiceCommands(
                "Meet at seven comma not eight full stop Are you free question mark Yes exclamation point",
            ),
        )
        assertEquals(
            "First: ready; second: waiting.",
            applyVoiceCommands("First colon ready semicolon second colon waiting period"),
        )
    }

    @Test
    fun `quotes parentheses ellipses and hyphens are supported`() {
        assertEquals(
            "He said \"this works\". Use (beta) - ready\u2026",
            applyVoiceCommands(
                "He said open quote this works close quote full stop Use open parenthesis beta close parenthesis hyphen ready ellipsis",
            ),
        )
        assertEquals("\"Ready\".", applyVoiceCommands("open quote Ready close quote full stop"))
    }

    @Test
    fun `does not duplicate punctuation already emitted around a command`() {
        assertEquals(
            "Ready.\n\nNext step.",
            applyVoiceCommands("Ready. Full stop. New paragraph. Next step."),
        )
        assertEquals("Hello, world.", applyVoiceCommands("Hello, comma, world."))
    }

    @Test
    fun `common paragraph variants are supported`() {
        assertEquals(
            "First thought\n\nSecond thought",
            applyVoiceCommands("First thought blank line second thought"),
        )
        assertEquals(
            "First thought\n\nSecond thought",
            applyVoiceCommands("First thought start a new paragraph second thought"),
        )
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
        assertEquals(
            "Use a comma between the clauses.",
            applyVoiceCommands("Use a comma between the clauses."),
        )
        assertEquals("The period ended yesterday.", applyVoiceCommands("The period ended yesterday."))
        assertEquals("The trial period ends tomorrow.", applyVoiceCommands("The trial period ends tomorrow."))
        assertEquals("Use comma-separated values.", applyVoiceCommands("Use comma-separated values."))
        assertEquals("Press the hyphen key.", applyVoiceCommands("Press the hyphen key."))
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
