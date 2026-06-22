package com.tanay.echo.snippet

/** A user-defined voice snippet: speak [cue], and Echo pastes [expansion] (a canned block). */
data class Snippet(val cue: String, val expansion: String)

/**
 * If [text] (what you just dictated) matches a snippet's [Snippet.cue] — ignoring case, surrounding
 * whitespace, collapsed inner spaces, and trailing sentence punctuation — return its expansion; else
 * null. The match is on the whole utterance, so saying a cue inside a longer sentence inserts the
 * words literally (near-zero false positives). First match wins.
 */
fun expandSnippet(text: String, snippets: List<Snippet>): String? {
    val key = normalizeCue(text)
    if (key.isEmpty()) return null
    return snippets.firstOrNull { normalizeCue(it.cue) == key }?.expansion
}

private fun normalizeCue(s: String): String =
    s.lowercase()
        .replace(Regex("\\s+"), " ")
        .trim()
        .trim('.', ',', '!', '?', ';', ':', '"', '\'')
        .trim()
