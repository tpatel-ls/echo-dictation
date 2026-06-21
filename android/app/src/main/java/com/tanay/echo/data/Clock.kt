package com.tanay.echo.data

/**
 * A clock that never returns the same value twice and only ever moves forward, so every write
 * gets a unique, strictly-increasing updatedAt. That uniqueness is what lets the sync push
 * watermark use a strict `>` without ever stranding a row written in the same millisecond as a
 * prior push. A verbatim port of src/main/store/clock.ts. `timeSource` is injectable for tests.
 */
class MonotonicClock(private val timeSource: () -> Long = { System.currentTimeMillis() }) {
    private var last = 0L

    @Synchronized
    fun now(): Long {
        last = maxOf(timeSource(), last + 1)
        return last
    }
}
