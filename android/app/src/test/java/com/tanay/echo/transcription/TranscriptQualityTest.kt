package com.tanay.echo.transcription

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TranscriptQualityTest {
    @Test
    fun rejectsForeignDecoderDriftAndAssistantReplies() {
        assertEquals(
            TranscriptGrade.REJECT,
            assessTranscript("Einn snop og þá minn ekki röggli og feitsið gís.").grade,
        )
        assertEquals(
            TranscriptGrade.REJECT,
            assessTranscript("Sure, here is the cleaned transcript: It is not working correctly.").grade,
        )
        assertEquals(TranscriptGrade.REJECT, assessTranscript("Open 東京 now.").grade)
    }

    @Test
    fun keepsNormalEnglishAndGlossaryTerms() {
        assertEquals(TranscriptGrade.CLEAN, assessTranscript("How is it going today?").grade)
        assertEquals(
            TranscriptGrade.CLEAN,
            assessTranscript("Open 東京 now.", glossary = listOf("東京")).grade,
        )
    }

    @Test
    fun ranksCleanCandidatesAndRejectsAnAllBadSet() {
        val winner = chooseTranscript(
            listOf(
                TranscriptCandidate(CandidateSource.REMOTE_PRIMARY, "Einn snop og þá.", 80),
                TranscriptCandidate(CandidateSource.REMOTE_RECOVERY, "How is it going today?", 95),
            ),
        )
        assertEquals("How is it going today?", winner?.text)
        assertNull(
            chooseTranscript(
                listOf(TranscriptCandidate(CandidateSource.REMOTE_PRIMARY, "You're welcome!", 80)),
            ),
        )
    }
}
