package com.tanay.echo.transcription

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppStyleTest {
    // styleForPackage: the curated map drives BOTH the register and whether to spend the AI pass.

    @Test
    fun `chat apps are casual and still get the AI pass`() {
        val p = styleForPackage("com.whatsapp")
        assertEquals(Register.CASUAL, p.register)
        assertTrue("always-on cleanup — casual register, light touch", p.runCleanup)
    }

    @Test
    fun `email apps are professional and get polished`() {
        val p = styleForPackage("com.google.android.gm")
        assertEquals(Register.PROFESSIONAL, p.register)
        assertTrue(p.runCleanup)
    }

    @Test
    fun `notes apps are neutral and polished`() {
        val p = styleForPackage("com.google.android.keep")
        assertEquals(Register.NEUTRAL, p.register)
        assertTrue(p.runCleanup)
    }

    @Test
    fun `browsers are neutral and polished since the site is unknown`() {
        val p = styleForPackage("com.android.chrome")
        assertEquals(Register.NEUTRAL, p.register)
        assertTrue(p.runCleanup)
    }

    @Test
    fun `unknown apps fall through to infer and get polished`() {
        val p = styleForPackage("com.acme.somethingnew")
        assertEquals(Register.INFER, p.register)
        assertTrue(p.runCleanup)
    }

    @Test
    fun `blank package is neutral and polished`() {
        val p = styleForPackage("")
        assertEquals(Register.NEUTRAL, p.register)
        assertTrue(p.runCleanup)
    }

    // styleDirective: the extra system-prompt line per register (null for NEUTRAL = base prompt as-is).

    @Test
    fun `neutral has no directive`() {
        assertNull(styleDirective(Register.NEUTRAL))
    }

    @Test
    fun `professional directive asks for professional formatting`() {
        val d = styleDirective(Register.PROFESSIONAL)
        assertNotNull(d)
        assertTrue(d!!.contains("professional", ignoreCase = true))
    }

    @Test
    fun `infer directive weaves in the package hint`() {
        val d = styleDirective(Register.INFER, "com.acme.somethingnew")
        assertNotNull(d)
        assertTrue(d!!.contains("com.acme.somethingnew"))
    }

    @Test
    fun `infer directive omits a blank hint gracefully`() {
        val d = styleDirective(Register.INFER, "")
        assertNotNull(d)
        assertFalse("no empty quotes when there's no hint", d!!.contains("\"\""))
    }
}
