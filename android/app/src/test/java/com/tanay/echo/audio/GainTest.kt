package com.tanay.echo.audio

import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.abs

class GainTest {
    private fun peak(p: ShortArray): Int {
        var m = 0
        for (s in p) { val a = abs(s.toInt()); if (a > m) m = a }
        return m
    }

    @Test
    fun `amplifies quiet audio toward the target peak`() {
        val out = boostGain(shortArrayOf(2000, -1000, 500), targetPeak = 20000, maxGain = 16f)
        assertEquals(20000, peak(out)) // factor 20000/2000 = 10
    }

    @Test
    fun `does not amplify already-loud audio`() {
        assertEquals(listOf<Short>(30000, -28000), boostGain(shortArrayOf(30000, -28000), targetPeak = 22000).toList())
    }

    @Test
    fun `caps the gain factor`() {
        // peak 100, target 22000 ⇒ factor 220, capped at 16 ⇒ 1600
        assertEquals(1600, peak(boostGain(shortArrayOf(100), targetPeak = 22000, maxGain = 16f)))
    }

    @Test
    fun `clamps amplified samples to the 16-bit range`() {
        // peak 10000, target 40000 ⇒ factor 4 ⇒ 40000, clamped to 32767
        assertEquals(32767, peak(boostGain(shortArrayOf(10000), targetPeak = 40000, maxGain = 16f)))
    }

    @Test
    fun `leaves silence unchanged`() {
        assertEquals(listOf<Short>(0, 0), boostGain(shortArrayOf(0, 0)).toList())
    }
}
