package com.tanay.echo.dictionary

// Deterministic dictionary replacement + Whisper bias prompt. Faithful Kotlin port of the
// pure parts of src/shared/dictionary.ts (the desktop's learn/diff logic stays desktop-only).
// No Android APIs → unit-testable on a plain JVM (see DictionaryTest).

/** Mirrors the desktop DictionaryEntry — the fields replacement + biasing need. */
data class DictionaryEntry(
    val id: Long,
    val word: String, // canonical spelling, e.g. "Bryan"
    val misheard: List<String>, // aliases Whisper produces, e.g. ["Brian"]
    val source: String = "manual",
    val createdAt: Long = 0,
    val timesApplied: Int = 0
)

data class ApplyResult(val text: String, val appliedIds: List<Long>)

// \b is ASCII-only in Java regex; these lookarounds give Unicode-aware whole-word boundaries.
private const val BOUNDARY_BEFORE = "(?<![\\p{L}\\p{N}])"
private const val BOUNDARY_AFTER = "(?![\\p{L}\\p{N}])"
private val WHITESPACE = Regex("\\s+")
private val META = setOf('.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\')

private fun escapeRegex(s: String): String = buildString {
    for (c in s) {
        if (c in META) append('\\')
        append(c)
    }
}

/** Case-insensitive whole-word matcher; multi-word aliases tolerate any whitespace. */
private fun aliasPattern(alias: String): Regex {
    val tokens = alias.trim().split(WHITESPACE).map(::escapeRegex)
    return Regex(
        BOUNDARY_BEFORE + tokens.joinToString("\\s+") + BOUNDARY_AFTER,
        setOf(RegexOption.IGNORE_CASE, RegexOption.UNICODE_CASE)
    )
}

private data class AliasOf(val alias: String, val entry: DictionaryEntry)

/**
 * Replace every misheard alias with its entry's canonical word. The canonical word itself
 * also acts as an alias so wrong casing gets fixed ("github" → "GitHub"). Longer aliases run
 * first so "mac mini" wins over "mac". Returns the ids of entries that actually changed text.
 */
fun applyDictionary(text: String, entries: List<DictionaryEntry>): ApplyResult {
    val pairs = mutableListOf<AliasOf>()
    for (entry in entries) {
        val word = entry.word.trim()
        if (word.isEmpty()) continue
        val seen = HashSet<String>()
        for (alias in listOf(word) + entry.misheard) {
            val a = alias.trim().replace(WHITESPACE, " ")
            val key = a.lowercase()
            if (a.isEmpty() || !seen.add(key)) continue
            pairs.add(AliasOf(a, entry))
        }
    }
    // Longer aliases (more words, then more chars) first. sortedWith is stable, matching JS sort.
    pairs.sortWith(
        compareByDescending<AliasOf> { it.alias.split(" ").size }.thenByDescending { it.alias.length }
    )

    var out = text
    val applied = LinkedHashSet<Long>()
    for (p in pairs) {
        out = aliasPattern(p.alias).replace(out) { m ->
            if (m.value == p.entry.word) m.value // already correct — not an application
            else {
                applied.add(p.entry.id)
                p.entry.word
            }
        }
    }
    return ApplyResult(out, applied.toList())
}

/**
 * Comma-joined canonical words (never aliases — they would bias toward the wrong spelling),
 * most-used then most-recent first, truncated to a char budget that stays under Whisper's
 * 224-token prompt window.
 */
fun buildBiasPrompt(entries: List<DictionaryEntry>, maxChars: Int = 600): String {
    val sorted = entries.sortedWith(
        compareByDescending<DictionaryEntry> { it.timesApplied }.thenByDescending { it.createdAt }
    )
    var out = ""
    for (e in sorted) {
        val word = e.word.trim()
        if (word.isEmpty()) continue
        val next = if (out.isEmpty()) word else "$out, $word"
        if (next.length > maxChars) break
        out = next
    }
    return out
}
