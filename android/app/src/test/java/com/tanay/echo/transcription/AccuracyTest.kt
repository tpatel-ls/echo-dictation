package com.tanay.echo.transcription

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class AccuracyTest {
    @Test
    fun unknownAccuracyModeDefaultsToBalanced() {
        assertEquals(AccuracyMode.BALANCED, AccuracyMode.from("unknown"))
    }

    @Test
    fun balancedModeRetriesARejectedPrimary() = runTest {
        val temperatures = mutableListOf<Double>()
        val outcome = recognizeAccurately(
            mode = AccuracyMode.BALANCED,
            decode = { temperature ->
                temperatures += temperature
                if (temperature == 0.0) "Einn snop og þá." else "How is it going today?"
            },
        )

        assertEquals(listOf(0.0, 0.3), temperatures)
        assertEquals("How is it going today?", outcome.winner.text)
    }

    @Test
    fun maximumModeUsesFiveHypothesesAndGroundedAdjudication() = runTest {
        val index = AtomicInteger()
        val hypotheses = listOf(
            "How is it going today?",
            "How's it going today?",
            "How is it going today?",
            "How is it going today?",
            "How is it going to day?",
        )
        var seenCandidates = 0
        val outcome = recognizeAccurately(
            mode = AccuracyMode.MAXIMUM,
            decode = { hypotheses[index.getAndIncrement()] },
            adjudicate = { candidates ->
                seenCandidates = candidates.size
                "How is it going today?"
            },
        )

        assertEquals(5, index.get())
        assertEquals(5, seenCandidates)
        assertEquals(CandidateSource.ADJUDICATED, outcome.winner.source)
        assertEquals("How is it going today?", outcome.winner.text)
    }

    @Test
    fun maximumModeRejectsAnUnsupportedReconstruction() = runTest {
        val index = AtomicInteger()
        val hypotheses = listOf(
            "How is it going today?",
            "How's it going today?",
            "How has it gone today?",
            "How did it go today?",
            "How will it go today?",
        )
        try {
            recognizeAccurately(
                mode = AccuracyMode.MAXIMUM,
                decode = { hypotheses[index.getAndIncrement()] },
                adjudicate = { "The quarterly report is ready." },
            )
            fail("expected low confidence")
        } catch (e: LowConfidenceRecognitionException) {
            assertTrue(e.message!!.contains("confidence"))
        }
    }

    @Test
    fun fastModeNeverInsertsARejectedReply() = runTest {
        try {
            recognizeAccurately(
                mode = AccuracyMode.FAST,
                decode = { "Let me know if you need anything else." },
            )
            fail("expected low confidence")
        } catch (_: LowConfidenceRecognitionException) {
            // expected
        }
    }

    @Test
    fun balancedModeKeepsBestSuspiciousEnglishCandidateAfterBoundedRescue() = runTest {
        val index = AtomicInteger()
        val hypotheses = listOf("How do I force figure out?", "You're welcome.")

        val outcome = recognizeAccurately(
            mode = AccuracyMode.BALANCED,
            decode = { hypotheses[index.getAndIncrement()] },
        )

        assertEquals("How do I force figure out?", outcome.winner.text)
    }
}
