package com.tanay.echo.transcription

/**
 * Spoken formatting commands: "new paragraph" / "leave space" → blank line, "new line" → line
 * break. Deterministic and instant — applied right after dictionary correction, before any AI
 * cleanup, so commands work even when the cleanup endpoint is down. Mirrors the desktop
 * src/shared/voice-commands.ts exactly.
 */

private const val PARAGRAPH_PHRASES = """(?:new|next)\s+paragraph|paragraph\s+break|leave\s+(?:a\s+)?(?:space|gap)"""
private const val LINE_PHRASES = """(?:new|next)\s+line|line\s+break"""

// Optional leading article ("a new paragraph about X") marks the phrase as content, not a command.
private val COMMAND = Regex(
    """(\b(?:a|the|one)\s+)?\b($PARAGRAPH_PHRASES|$LINE_PHRASES)\b[.,!?;:]*\s*""",
    RegexOption.IGNORE_CASE,
)

private val SPACE_BEFORE_BREAK = Regex("""[ \t]+\n""")
private val EXTRA_BREAKS = Regex("""\n{3,}""")
private val LOWER_AFTER_BREAK = Regex("""\n([a-z])""")
private val LEADING_BREAKS = Regex("""^\n+""")
private val TRAILING_WHITESPACE = Regex("""\s+$""")

/**
 * Replace spoken formatting commands in a transcript with real breaks: paragraph commands become a
 * blank line, line commands a single newline. Whisper's own punctuation around the command is
 * absorbed, the first word after a break is capitalized, and phrases preceded by an article
 * ("add a new paragraph about…") are left literal. Total — never throws.
 */
fun applyVoiceCommands(text: String): String {
    if (text.isEmpty()) return text

    val replaced = COMMAND.replace(text) { m ->
        val article = m.groupValues[1]
        val phrase = m.groupValues[2]
        when {
            article.isNotEmpty() -> m.value
            phrase.contains("line", ignoreCase = true) -> "\n"
            else -> "\n\n"
        }
    }

    return replaced
        .replace(SPACE_BEFORE_BREAK, "\n")
        .replace(EXTRA_BREAKS, "\n\n")
        .replace(LOWER_AFTER_BREAK) { "\n" + it.groupValues[1].uppercase() }
        .replace(LEADING_BREAKS, "")
        .replace(TRAILING_WHITESPACE, "")
}
