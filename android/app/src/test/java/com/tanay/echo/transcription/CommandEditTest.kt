package com.tanay.echo.transcription

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandEditTest {
    // selectedText: the highlighted slice that becomes the command's target (null = nothing to act on).

    @Test
    fun `selectedText returns the highlighted slice`() {
        assertEquals("ell", selectedText("hello", 1, 4))
    }

    @Test
    fun `selectedText is null when nothing is selected`() {
        assertNull(selectedText("hello", 2, 2))
    }

    @Test
    fun `selectedText is null for an out-of-range selection`() {
        assertNull(selectedText("hi", 0, 5))
        assertNull(selectedText("hi", -1, 1))
    }

    // undoSliceMatches: only restore the original if the rewrite is still exactly where we left it
    // (guards against clobbering edits the user made during the 5s undo window).

    @Test
    fun `undoSliceMatches true when the rewrite is still there`() {
        assertTrue(undoSliceMatches("a REWRITE b", 2, "REWRITE"))
    }

    @Test
    fun `undoSliceMatches false when the user edited the slice`() {
        assertFalse(undoSliceMatches("a CHANGED b", 2, "REWRITE"))
    }

    @Test
    fun `undoSliceMatches false when out of bounds`() {
        assertFalse(undoSliceMatches("short", 2, "REWRITE"))
    }
}
