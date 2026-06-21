package com.tanay.echo.floating

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SilenceDetectorTest {
    @Test
    fun `fires after sustained silence following speech`() {
        val d = SilenceDetector(thresholdRms = 0.05f, silenceMs = 1000)
        assertFalse(d.update(0.30f, 0)) // speech
        assertFalse(d.update(0.01f, 200)) // quiet, not long enough
        assertFalse(d.update(0.01f, 900))
        assertTrue(d.update(0.01f, 1300)) // quiet >= 1000ms since speech ended
    }

    @Test
    fun `does not fire before any speech`() {
        val d = SilenceDetector(thresholdRms = 0.05f, silenceMs = 1000)
        assertFalse(d.update(0.01f, 0))
        assertFalse(d.update(0.01f, 5000)) // silence but the user never spoke
    }

    @Test
    fun `speech resets the silence window`() {
        val d = SilenceDetector(thresholdRms = 0.05f, silenceMs = 1000)
        d.update(0.30f, 0)
        d.update(0.01f, 800)
        d.update(0.30f, 900) // speech again
        assertFalse(d.update(0.01f, 1500)) // only 600ms of silence since
        assertTrue(d.update(0.01f, 1950)) // now >= 1000ms
    }

    @Test
    fun `fires only once`() {
        val d = SilenceDetector(thresholdRms = 0.05f, silenceMs = 1000)
        d.update(0.30f, 0)
        assertTrue(d.update(0.01f, 1100))
        assertFalse(d.update(0.01f, 1200)) // already fired
    }

    @Test
    fun `reset re-arms the detector`() {
        val d = SilenceDetector(thresholdRms = 0.05f, silenceMs = 1000)
        d.update(0.30f, 0)
        assertTrue(d.update(0.01f, 1100))
        d.reset()
        assertFalse(d.update(0.01f, 1200)) // no speech since reset
        d.update(0.30f, 1300)
        assertTrue(d.update(0.01f, 2400))
    }
}
