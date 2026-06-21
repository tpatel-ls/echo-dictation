package com.tanay.echo.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Mirrors tests/sync.test.ts. The merge rule is the heart of correctness, identical on every
// platform. Authored on desktop; runs on your machine via `./gradlew test`.
class MergeTest {
    private fun meta(updatedAt: Long, deleted: Boolean = false) = SyncMeta("a", updatedAt, deleted)

    @Test
    fun appliesWhenNoLocalCopy() {
        assertTrue(shouldApply(null, meta(100)))
    }

    @Test
    fun appliesWhenIncomingStrictlyNewer() {
        assertTrue(shouldApply(meta(100), meta(101)))
    }

    @Test
    fun skipsWhenIncomingOlder() {
        assertFalse(shouldApply(meta(200), meta(199)))
    }

    @Test
    fun skipsWhenTimestampsEqual() {
        assertFalse(shouldApply(meta(150), meta(150)))
    }

    @Test
    fun newerTombstoneDeletesOlderLiveRecord() {
        assertTrue(shouldApply(meta(100, false), meta(101, true)))
    }

    @Test
    fun newerEditWinsOverOlderTombstone() {
        assertTrue(shouldApply(meta(100, true), meta(101, false)))
    }

    @Test
    fun advanceCursorKeepsCurrentForEmptyBatch() {
        assertEquals(7L, advanceCursor(7, emptyList()))
    }

    @Test
    fun advanceCursorAdvancesToHighestSeq() {
        assertEquals(10L, advanceCursor(7, listOf(8, 10, 9)))
    }

    @Test
    fun advanceCursorNeverMovesBackwards() {
        assertEquals(20L, advanceCursor(20, listOf(8, 12)))
    }
}
