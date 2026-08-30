package com.tanay.echo.transcription

// Mirrors the desktop src/shared/format.ts fast-path heuristic exactly.

private val FILLERS = Regex("""\b(?:um+|uh+|erm+|hmm+)\b""", RegexOption.IGNORE_CASE)
private val STUTTER = Regex("""\b(\w+)\s+\1\b""", RegexOption.IGNORE_CASE)
private val META_DIRECTIONS = Regex("""\b(?:email|write that|say that|scratch that|bullet)\b""", RegexOption.IGNORE_CASE)
private val BACKTRACKING = Regex("""\b(?:no[, ]+wait|i mean|rather|actually)\b""", RegexOption.IGNORE_CASE)
private val CLEAN_START = Regex("""^["'(]?[A-Z0-9]""")
private val CLEAN_END = Regex("""[.!?…]["')]?$""")
private const val MAX_INSTANT_WORDS = 12

/**
 * Fast path: a short dictation Whisper already punctuated cleanly (capitalized start, terminal
 * punctuation, no fillers/stutters, no breaks, no spoken directions) gains nothing from the AI
 * pass — skip it and insert instantly. Anything doubtful returns true and gets cleaned.
 */
fun needsAiCleanup(text: String): Boolean {
    val t = text.trim()
    if (t.isEmpty()) return true
    if (t.split(Regex("""\s+""")).count { it.isNotEmpty() } > MAX_INSTANT_WORDS) return true
    if (t.contains('\n')) return true
    if (FILLERS.containsMatchIn(t) || STUTTER.containsMatchIn(t) ||
        META_DIRECTIONS.containsMatchIn(t) || BACKTRACKING.containsMatchIn(t)
    ) return true
    if (!CLEAN_START.containsMatchIn(t)) return true
    if (!CLEAN_END.containsMatchIn(t)) return true
    return false
}
