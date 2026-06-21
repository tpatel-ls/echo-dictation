package com.tanay.echo.data

import org.junit.Assert.assertEquals
import org.junit.Test

// Mirrors tests/clock.test.ts. Authored on desktop; runs on your machine via `./gradlew test`.
class ClockTest {
    @Test
    fun tracksWallClockWhenItMovesForward() {
        var t = 1000L
        val clock = MonotonicClock { t }
        assertEquals(1000L, clock.now())
        t = 1005L
        assertEquals(1005L, clock.now())
    }

    @Test
    fun neverReturnsSameValueTwiceWhenFrozen() {
        val clock = MonotonicClock { 1000L }
        assertEquals(1000L, clock.now())
        assertEquals(1001L, clock.now())
        assertEquals(1002L, clock.now())
    }

    @Test
    fun neverGoesBackwardWhenTimeSourceRegresses() {
        var t = 5000L
        val clock = MonotonicClock { t }
        assertEquals(5000L, clock.now())
        t = 4000L // wall clock jumped back (NTP, DST, etc.)
        assertEquals(5001L, clock.now())
    }
}
