package com.tanay.echo.transcription

import java.util.Locale

enum class TranscriptGrade { CLEAN, SUSPICIOUS, REJECT }

enum class CandidateSource(val priority: Int) {
    ADJUDICATED(0),
    REMOTE_PRIMARY(1),
    REMOTE_RECOVERY(2),
}

data class TranscriptAssessment(
    val grade: TranscriptGrade,
    val score: Int,
    val reasons: List<String>,
)

data class TranscriptCandidate(
    val source: CandidateSource,
    val text: String,
    val elapsedMs: Long,
)

private val wordPattern = Regex("[\\p{L}\\p{N}']+")
private val functionWords = setOf(
    "a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "can", "could",
    "did", "do", "does", "for", "from", "had", "has", "have", "he", "her", "here", "him",
    "his", "how", "i", "if", "in", "into", "is", "it", "its", "me", "my", "not", "of", "on",
    "or", "our", "out", "she", "should", "that", "the", "their", "them", "there", "these",
    "they", "this", "those", "to", "up", "us", "was", "we", "were", "what", "when", "where",
    "which", "who", "why", "will", "with", "would", "you", "your",
)
private val questionLeaders = setOf("how", "what", "why", "when", "where")
private val auxiliaries = setOf("can", "could", "did", "do", "does", "should", "will", "would")
private val pronouns = setOf("he", "i", "it", "she", "they", "we", "you")
private val bareVerbs = setOf(
    "ask", "build", "call", "change", "deploy", "figure", "find", "fix", "force", "get", "go",
    "keep", "make", "move", "open", "push", "run", "send", "set", "show", "start", "stop",
    "take", "turn", "use", "work", "write",
)
private val particles = setOf("away", "back", "down", "in", "off", "on", "out", "over", "up")

private val assistantWrapper = Regex(
    """^\s*(?:(?:sure|certainly|absolutely|of course)[,:]?\s*)?(?:here(?:'s| is)\s+(?:the\s+)?(?:(?:cleaned|corrected|revised)\s+)?(?:transcript|transcription|result)\b|here(?:'s| is)\s+(?:the\s+)?(?:final\s+)?version\b|(?:cleaned|corrected|revised)\s+transcript\b|transcript:|transcription:|result:|version:)""",
    RegexOption.IGNORE_CASE,
)
private val assistantReply = Regex(
    """^\s*(?:you'?re welcome\b|let me know if\b|how can i help\b|how may i help\b|i can help\b|i can assist\b|happy to help\b|i'?d be happy to\b|sure[,! ]+i can\b|of course[,! ]+i can\b|certainly[,! ]+i can\b)""",
    RegexOption.IGNORE_CASE,
)

fun assessTranscript(text: String, glossary: List<String> = emptyList()): TranscriptAssessment {
    val trimmed = text.trim()
    val checkedText = stripGlossary(trimmed, glossary)
    val rejects = mutableListOf<String>()
    val suspicious = mutableListOf<String>()

    if (trimmed.isEmpty() || !trimmed.any { it.isLetterOrDigit() }) rejects += "empty"
    if (hasNonLatinScript(checkedText)) rejects += "non-latin-script"
    if (checkedText.any { it == 'ð' || it == 'þ' || it == 'Ð' || it == 'Þ' }) rejects += "forbidden-script"
    if (assistantWrapper.containsMatchIn(trimmed) || assistantReply.containsMatchIn(trimmed)) rejects += "assistant-reply"
    if (hasDecoderGarbage(checkedText)) rejects += "decoder-garbage"

    if (rejects.isEmpty()) {
        if (hasExtendedLatinSuspicion(checkedText)) suspicious += "extended-latin"
        if (hasBrokenQuestionPattern(trimmed)) suspicious += "broken-question"
        if (hasLowEnglishEvidence(checkedText)) suspicious += "low-english-evidence"
    }

    return when {
        rejects.isNotEmpty() -> TranscriptAssessment(TranscriptGrade.REJECT, 0, rejects)
        suspicious.isNotEmpty() -> TranscriptAssessment(
            TranscriptGrade.SUSPICIOUS,
            (70 - suspicious.size * 10).coerceAtLeast(1),
            suspicious,
        )
        else -> TranscriptAssessment(TranscriptGrade.CLEAN, 100, emptyList())
    }
}

fun chooseTranscript(
    candidates: List<TranscriptCandidate>,
    glossary: List<String> = emptyList(),
): TranscriptCandidate? = candidates
    .mapIndexed { index, candidate -> Triple(candidate, assessTranscript(candidate.text, glossary), index) }
    .filter { it.second.grade != TranscriptGrade.REJECT }
    .sortedWith(
        compareByDescending<Triple<TranscriptCandidate, TranscriptAssessment, Int>> { it.second.score }
            .thenBy { it.first.source.priority }
            .thenBy { it.third },
    )
    .firstOrNull()
    ?.first

private fun stripGlossary(text: String, glossary: List<String>): String {
    var result = text
    for (term in glossary) {
        val tokens = term.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (tokens.isEmpty()) continue
        val pattern = tokens.joinToString("\\s+") { Regex.escape(it) }
        result = Regex(
            "(?<![\\p{L}\\p{N}])$pattern(?![\\p{L}\\p{N}])",
            RegexOption.IGNORE_CASE,
        ).replace(result, " ")
    }
    return result
}

private fun words(text: String): List<String> = wordPattern.findAll(text).map { it.value }.toList()

private fun hasNonLatinScript(text: String): Boolean = text.codePoints().toArray().any { codePoint ->
    Character.isLetter(codePoint) && Character.UnicodeScript.of(codePoint) != Character.UnicodeScript.LATIN
}

private fun hasExtendedLatinSuspicion(text: String): Boolean {
    val tokens = words(text)
    val functionCount = tokens.count { it.lowercase(Locale.US) in functionWords }
    var lowercaseAccented = 0
    var extendedLetters = 0
    for (token in tokens) {
        val count = token.count { it.isLetter() && it.code > 127 }
        if (count == 0) continue
        extendedLetters += count
        if (token.firstOrNull()?.isLowerCase() == true) lowercaseAccented++
    }
    return functionCount < 2 && lowercaseAccented >= 2 && extendedLetters >= 3
}

private fun hasDecoderGarbage(text: String): Boolean {
    val tokens = words(text).map { it.lowercase(Locale.US) }
    if (tokens.size < 4) return false
    var run = 1
    for (i in 1 until tokens.size) {
        run = if (tokens[i] == tokens[i - 1]) run + 1 else 1
        if (run >= 3) return true
    }
    val largestCount = tokens.groupingBy { it }.eachCount().values.maxOrNull() ?: 0
    return largestCount >= ((tokens.size + 1) / 2) + 1
}

private fun hasBrokenQuestionPattern(text: String): Boolean {
    if (!text.trim().endsWith('?')) return false
    val tokens = words(text).map { it.lowercase(Locale.US) }
    if (tokens.size < 6 || tokens[0] !in questionLeaders || tokens[1] !in auxiliaries || tokens[2] !in pronouns) return false
    val tail = tokens.drop(3)
    if (tail.size < 3 || tail.any { it !in bareVerbs && it !in particles }) return false
    return tail.zipWithNext().any { (left, right) -> left in bareVerbs && right in bareVerbs }
}

private fun hasLowEnglishEvidence(text: String): Boolean {
    val tokens = words(text)
    if (tokens.size < 4) return false
    val functionCount = tokens.count { it.lowercase(Locale.US) in functionWords }
    val technicalCount = tokens.count { token -> token.any { it.isUpperCase() } || token.any { it.isDigit() } }
    return functionCount == 0 && technicalCount < 2
}
