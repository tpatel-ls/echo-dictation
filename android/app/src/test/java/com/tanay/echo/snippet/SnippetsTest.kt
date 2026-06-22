package com.tanay.echo.snippet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SnippetsTest {
    private val snips = listOf(
        Snippet("my address", "123 Main St, Springfield"),
        Snippet("Scheduling Link", "https://cal.com/tanay/30min"),
    )

    @Test
    fun `exact cue returns its expansion`() {
        assertEquals("123 Main St, Springfield", expandSnippet("my address", snips))
    }

    @Test
    fun `match ignores case and a trailing period`() {
        assertEquals("123 Main St, Springfield", expandSnippet("My address.", snips))
        assertEquals("https://cal.com/tanay/30min", expandSnippet("scheduling link", snips))
    }

    @Test
    fun `match ignores surrounding whitespace and collapses inner spaces`() {
        assertEquals("123 Main St, Springfield", expandSnippet("  my   address  ", snips))
    }

    @Test
    fun `a cue inside a sentence does not expand`() {
        assertNull(expandSnippet("what is my address again", snips))
    }

    @Test
    fun `no match returns null`() {
        assertNull(expandSnippet("phone number", snips))
    }

    @Test
    fun `blank input returns null`() {
        assertNull(expandSnippet("", snips))
        assertNull(expandSnippet("   ", snips))
    }

    @Test
    fun `first matching snippet wins`() {
        val dupes = listOf(Snippet("hi", "first"), Snippet("HI", "second"))
        assertEquals("first", expandSnippet("hi", dupes))
    }
}
