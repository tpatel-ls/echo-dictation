package com.tanay.echo.floating

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GestureInterpreterTest {
    @Test
    fun `quick press-release is a tap`() {
        val g = GestureInterpreter()
        g.down(0f, 0f)
        assertEquals(Gesture.Tap, g.up())
    }

    @Test
    fun `long-press timer then release is a hold`() {
        val g = GestureInterpreter()
        g.down(0f, 0f)
        assertEquals(Gesture.HoldStart, g.holdTimerFired())
        assertEquals(Gesture.HoldEnd, g.up())
    }

    @Test
    fun `movement beyond slop is a drag, not a tap`() {
        val g = GestureInterpreter(touchSlopPx = 16f)
        g.down(0f, 0f)
        val m = g.move(40f, 0f)
        assertTrue(m is Gesture.Drag)
        assertNull(g.up()) // dragged → not a tap
    }

    @Test
    fun `hold timer does not start a hold after a drag has begun`() {
        val g = GestureInterpreter(touchSlopPx = 16f)
        g.down(0f, 0f)
        g.move(40f, 0f) // drag
        assertNull(g.holdTimerFired()) // a late timer must not flip a drag into a hold
    }

    @Test
    fun `small jitter within slop still taps`() {
        val g = GestureInterpreter(touchSlopPx = 16f)
        g.down(0f, 0f)
        assertNull(g.move(5f, 5f)) // within slop — no drag
        assertEquals(Gesture.Tap, g.up())
    }
}
