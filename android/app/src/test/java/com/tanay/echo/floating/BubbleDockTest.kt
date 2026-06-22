package com.tanay.echo.floating

import org.junit.Assert.assertEquals
import org.junit.Test

class BubbleDockTest {
    // Geometry: lp.y is a bottom inset (px from the screen bottom). The visible pill should clear the
    // keyboard top by `gap`; the window carries `glowPad` of transparent ring below the pill. So
    // inset = screenHeight - keyboardTop + gap - glowPad, when the keyboard top reads plausibly.

    @Test
    fun `docks above a plausibly reported keyboard top`() {
        // H=2000, kb top at 1200 (keyboard fills the bottom 40% — plausible), gap 30, glow 40.
        assertEquals(2000 - 1200 + 30 - 40, BubbleDock.defaultDockInset(2000, 1200, 30, 40, 0.45f))
    }

    @Test
    fun `ignores a zero keyboard top and assumes the fallback height`() {
        // top=0 is the broken read that used to drop the bubble into the middle of the keys. With a
        // 0.45 fallback the keyboard is assumed to fill the bottom 45%, so top := 1100.
        assertEquals(2000 - 1100 + 30 - 40, BubbleDock.defaultDockInset(2000, 0, 30, 40, 0.45f))
    }

    @Test
    fun `ignores an implausibly low keyboard top and uses the fallback`() {
        // top=1900 (0.95H) implies a sliver of a keyboard — a mid-animation/full-window read. Reject it.
        assertEquals(2000 - 1100 + 30 - 40, BubbleDock.defaultDockInset(2000, 1900, 30, 40, 0.45f))
    }

    @Test
    fun `trusts the lower plausibility boundary`() {
        // top=1600 is exactly 0.80H — the lowest top we still trust (keyboard fills the bottom 20%).
        assertEquals(2000 - 1600 + 30 - 40, BubbleDock.defaultDockInset(2000, 1600, 30, 40, 0.45f))
    }

    @Test
    fun `never returns a negative inset`() {
        // Pathological: a huge glow ring would push the inset below zero; clamp to the screen bottom.
        assertEquals(0, BubbleDock.defaultDockInset(2000, 1600, 0, 1000, 0.45f))
    }
}
