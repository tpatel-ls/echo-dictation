package com.tanay.echo.transcription

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import java.util.Locale

enum class AccuracyMode {
    FAST,
    BALANCED,
    MAXIMUM;

    companion object {
        fun from(value: String): AccuracyMode = entries.firstOrNull {
            it.name.equals(value.trim(), ignoreCase = true)
        } ?: MAXIMUM
    }
}

data class RecognitionOutcome(
    val winner: TranscriptCandidate,
    val candidates: List<TranscriptCandidate>,
)

class LowConfidenceRecognitionException : Exception("Low confidence transcription; nothing was inserted")

suspend fun recognizeAccurately(
    mode: AccuracyMode,
    glossary: List<String> = emptyList(),
    decode: suspend (temperature: Double) -> String,
    adjudicate: suspend (candidates: List<TranscriptCandidate>) -> String? = { null },
): RecognitionOutcome {
    val candidates = mutableListOf<TranscriptCandidate>()

    if (mode == AccuracyMode.MAXIMUM) {
        val temperatures = listOf(0.0, 0.3, 0.3, 0.3, 0.8)
        val decoded = coroutineScope {
            temperatures.mapIndexed { index, temperature ->
                async {
                    runCatching {
                        decodeCandidate(
                            decode = decode,
                            temperature = temperature,
                            source = if (index == 0) CandidateSource.REMOTE_PRIMARY else CandidateSource.REMOTE_RECOVERY,
                        )
                    }.getOrNull()
                }
            }.awaitAll()
        }
        candidates += decoded.filterNotNull()
    } else {
        candidates += decodeCandidate(decode, 0.0, CandidateSource.REMOTE_PRIMARY)
        val primaryGrade = assessTranscript(candidates.first().text, glossary).grade
        if (mode == AccuracyMode.BALANCED && primaryGrade != TranscriptGrade.CLEAN) {
            runCatching {
                decodeCandidate(decode, 0.3, CandidateSource.REMOTE_RECOVERY)
            }.getOrNull()?.let(candidates::add)
        }
    }

    return finalizeRecognition(candidates, mode, glossary, adjudicate)
}

private suspend fun decodeCandidate(
    decode: suspend (temperature: Double) -> String,
    temperature: Double,
    source: CandidateSource,
): TranscriptCandidate {
    val started = System.nanoTime()
    val text = decode(temperature)
    val elapsedMs = (System.nanoTime() - started) / 1_000_000
    return TranscriptCandidate(source, text.trim(), elapsedMs)
}

private suspend fun finalizeRecognition(
    candidates: MutableList<TranscriptCandidate>,
    mode: AccuracyMode,
    glossary: List<String>,
    adjudicate: suspend (candidates: List<TranscriptCandidate>) -> String?,
): RecognitionOutcome {
    val clean = candidates.filter { assessTranscript(it.text, glossary).grade == TranscriptGrade.CLEAN }.toMutableList()
    val disagreement = candidates.map { normalizeExact(it.text) }.filter { it.isNotEmpty() }.toSet().size > 1
    var acceptedAdjudication = false

    if (disagreement) {
        val text = runCatching { adjudicate(candidates.toList()) }.getOrNull()?.trim().orEmpty()
        val minimumSupport = if (mode == AccuracyMode.MAXIMUM) 2 else 1
        if (
            text.isNotEmpty() &&
            assessTranscript(text, glossary).grade == TranscriptGrade.CLEAN &&
            supportCount(text, candidates) >= minimumSupport
        ) {
            val candidate = TranscriptCandidate(CandidateSource.ADJUDICATED, text, 0)
            candidates += candidate
            clean += candidate
            acceptedAdjudication = true
        }
    }

    if (mode == AccuracyMode.MAXIMUM && disagreement && !acceptedAdjudication) {
        exactConsensus(clean, glossary)?.let { return RecognitionOutcome(it, candidates.toList()) }
        throw LowConfidenceRecognitionException()
    }

    val winner = chooseTranscript(clean, glossary) ?: throw LowConfidenceRecognitionException()
    return RecognitionOutcome(winner, candidates.toList())
}

private fun exactConsensus(
    candidates: List<TranscriptCandidate>,
    glossary: List<String>,
): TranscriptCandidate? {
    val group = candidates
        .groupBy { normalizeExact(it.text) }
        .filterKeys { it.isNotEmpty() }
        .values
        .filter { it.size >= 2 }
        .maxByOrNull { it.size }
        ?: return null
    return chooseTranscript(group, glossary)
}

private fun supportCount(text: String, candidates: List<TranscriptCandidate>): Int {
    val target = normalizeForSupport(text)
    return candidates.count { supportSimilarity(target, normalizeForSupport(it.text)) >= 0.72 }
}

private fun normalizeExact(text: String): String = text.trim().lowercase(Locale.US).replace(Regex("\\s+"), " ")

private fun normalizeForSupport(text: String): String {
    val expanded = text.lowercase(Locale.US)
        .replace('’', '\'')
        .replace(Regex("\\bi'm\\b"), "i am")
        .replace(Regex("\\b(he|how|it|she|that|there|what|where|who)'s\\b"), "$1 is")
        .replace(Regex("\\bcan't\\b"), "cannot")
        .replace(Regex("\\bwon't\\b"), "will not")
        .replace(Regex("n't\\b"), " not")
        .replace(Regex("'re\\b"), " are")
        .replace(Regex("'ve\\b"), " have")
        .replace(Regex("'ll\\b"), " will")
    return Regex("[\\p{L}\\p{N}]+").findAll(expanded).joinToString(" ") { it.value }
}

private fun supportSimilarity(left: String, right: String): Double {
    if (left.isEmpty() || right.isEmpty()) return 0.0
    if (left == right) return 1.0
    val leftTokens = left.split(' ')
    val rightCounts = right.split(' ').groupingBy { it }.eachCount().toMutableMap()
    var overlap = 0
    for (token in leftTokens) {
        val count = rightCounts[token] ?: 0
        if (count > 0) {
            overlap++
            rightCounts[token] = count - 1
        }
    }
    val rightSize = right.split(' ').size
    val tokenDice = 2.0 * overlap / (leftTokens.size + rightSize)
    val charSimilarity = 1.0 - editDistance(left, right).toDouble() / maxOf(left.length, right.length)
    return maxOf(tokenDice, charSimilarity)
}

private fun editDistance(left: String, right: String): Int {
    var previous = IntArray(right.length + 1) { it }
    for (i in 1..left.length) {
        val current = IntArray(right.length + 1)
        current[0] = i
        for (j in 1..right.length) {
            current[j] = minOf(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + if (left[i - 1] == right[j - 1]) 0 else 1,
            )
        }
        previous = current
    }
    return previous[right.length]
}
