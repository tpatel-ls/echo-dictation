package com.tanay.echo.transcription

/**
 * Spoken formatting commands: paragraph/line breaks and named punctuation become their literal
 * characters. Deterministic and instant, so core English commands still work without AI cleanup.
 * Mirrors desktop src/shared/voice-commands.ts.
 */

private const val PARAGRAPH_PHRASES =
    """(?:start|begin|make)\s+(?:a\s+)?new\s+paragraph|(?:new|next)\s+paragraph|paragraph\s+break|blank\s+line|leave\s+(?:a\s+)?(?:space|gap)"""
private const val LINE_PHRASES = """(?:new|next)\s+line|line\s+break"""
private const val PUNCTUATION_PHRASES =
    """full\s+stop|period|comma|question\s+mark|exclamation\s+(?:mark|point)|colon|semi[ -]?colon|ellipsis|dot\s+dot\s+dot|hyphen|(?:open|left)\s+parenthes(?:is|es)|(?:close|right)\s+parenthes(?:is|es)|(?:open|begin|start)\s+quote|(?:close|end)\s+quote"""

// Optional leading article ("a new paragraph about X") marks the phrase as content, not a command.
private val BREAK_COMMAND = Regex(
    """(\b(?:a|the|one)\s+)?\b($PARAGRAPH_PHRASES|$LINE_PHRASES)\b[.,!?;:]*\s*""",
    RegexOption.IGNORE_CASE,
)
private val PUNCTUATION_COMMAND = Regex(
    """(\b(?:a|the|one)\s+)?\b($PUNCTUATION_PHRASES)\b[.,!?;:]*[ \t]*""",
    RegexOption.IGNORE_CASE,
)

private const val MARK_COMMA = "\uE000"
private const val MARK_PERIOD = "\uE001"
private const val MARK_QUESTION = "\uE002"
private const val MARK_EXCLAMATION = "\uE003"
private const val MARK_COLON = "\uE004"
private const val MARK_SEMICOLON = "\uE005"
private const val MARK_ELLIPSIS = "\uE006"
private const val MARK_HYPHEN = "\uE007"
private const val MARK_OPEN_PAREN = "\uE008"
private const val MARK_CLOSE_PAREN = "\uE009"
private const val MARK_OPEN_QUOTE = "\uE00A"
private const val MARK_CLOSE_QUOTE = "\uE00B"

private val SPACE_BEFORE_BREAK = Regex("""[ \t]+\n""")
private val EXTRA_BREAKS = Regex("""\n{3,}""")
private val LOWER_AFTER_BREAK = Regex("""\n([a-z])""")
private val LOWER_AFTER_TERMINAL = Regex("""([.!?…]) ([a-z])""")
private val LEADING_BREAKS = Regex("""^\n+""")
private val TRAILING_WHITESPACE = Regex("""\s+$""")
private val TRAILING_LINE_WHITESPACE = Regex("""[ \t]+$""", RegexOption.MULTILINE)

/**
 * Replace spoken formatting commands in a transcript with real breaks: paragraph commands become a
 * blank line, line commands a single newline. Whisper's own punctuation around the command is
 * absorbed, the first word after a break is capitalized, and phrases preceded by an article
 * ("add a new paragraph about…") are left literal. Total — never throws.
 */
fun applyVoiceCommands(text: String): String {
    if (text.isEmpty()) return text

    var replaced = BREAK_COMMAND.replace(text) { m ->
        val article = m.groupValues[1]
        val phrase = m.groupValues[2]
        when {
            article.isNotEmpty() -> m.value
            phrase.contains("line", ignoreCase = true) && !phrase.contains("blank", ignoreCase = true) -> "\n"
            else -> "\n\n"
        }
    }

    val source = replaced
    replaced = PUNCTUATION_COMMAND.replace(replaced) { m ->
        val article = m.groupValues[1]
        val phrase = m.groupValues[2]
        if (article.isNotEmpty() || isClearlyLiteralPunctuation(m.range.first, m.value, source)) {
            m.value
        } else {
            punctuationMark(phrase)
        }
    }

    return replaced
        .replace(Regex("""[ \t]*$MARK_COMMA[ \t]*"""), ", ")
        .replace(Regex("""[ \t]*$MARK_PERIOD[ \t]*"""), ". ")
        .replace(Regex("""[ \t]*$MARK_QUESTION[ \t]*"""), "? ")
        .replace(Regex("""[ \t]*$MARK_EXCLAMATION[ \t]*"""), "! ")
        .replace(Regex("""[ \t]*$MARK_COLON[ \t]*"""), ": ")
        .replace(Regex("""[ \t]*$MARK_SEMICOLON[ \t]*"""), "; ")
        .replace(Regex("""[ \t]*$MARK_ELLIPSIS[ \t]*"""), "… ")
        .replace(Regex("""[ \t]*$MARK_HYPHEN[ \t]*"""), " - ")
        .replace(Regex("""[ \t]*$MARK_OPEN_PAREN[ \t]*"""), " (")
        .replace(Regex("""[ \t]*$MARK_CLOSE_PAREN"""), ")")
        .replace(Regex("""[ \t]*$MARK_OPEN_QUOTE[ \t]*"""), " \"")
        .replace(Regex("""[ \t]*$MARK_CLOSE_QUOTE"""), "\"")
        .replace(Regex("""([,;:])\1+"""), "$1")
        .replace(Regex("""([.!?…])[.!?…]+"""), "$1")
        .replace(Regex("""[,;:]+([.!?…])"""), "$1")
        .replace(Regex("""[ \t]{2,}"""), " ")
        .replace(LOWER_AFTER_TERMINAL) { "${it.groupValues[1]} ${it.groupValues[2].uppercase()}" }
        .replace(SPACE_BEFORE_BREAK, "\n")
        .replace(EXTRA_BREAKS, "\n\n")
        .replace(LOWER_AFTER_BREAK) { "\n" + it.groupValues[1].uppercase() }
        .replace(TRAILING_LINE_WHITESPACE, "")
        .replace(Regex("""^[ \t]+"""), "")
        .replace(LEADING_BREAKS, "")
        .replace(TRAILING_WHITESPACE, "")
}

private fun punctuationMark(phrase: String): String {
    val normalized = phrase.lowercase().replace(Regex("[ -]+"), " ")
    return when {
        normalized == "comma" -> MARK_COMMA
        normalized == "full stop" || normalized == "period" -> MARK_PERIOD
        normalized == "question mark" -> MARK_QUESTION
        normalized.startsWith("exclamation ") -> MARK_EXCLAMATION
        normalized == "colon" -> MARK_COLON
        normalized == "semicolon" || normalized == "semi colon" -> MARK_SEMICOLON
        normalized == "ellipsis" || normalized == "dot dot dot" -> MARK_ELLIPSIS
        normalized == "hyphen" -> MARK_HYPHEN
        Regex("""^(?:open|left) parenthes""").containsMatchIn(normalized) -> MARK_OPEN_PAREN
        Regex("""^(?:close|right) parenthes""").containsMatchIn(normalized) -> MARK_CLOSE_PAREN
        Regex("""^(?:open|begin|start) quote$""").matches(normalized) -> MARK_OPEN_QUOTE
        else -> MARK_CLOSE_QUOTE
    }
}

private fun isClearlyLiteralPunctuation(offset: Int, match: String, source: String): Boolean {
    val before = source.take(offset)
    val remainder = source.drop(offset + match.length)
    if (Regex("""^-?(?:separated|delimited|operator|character|key|symbol|means|is|was|ended|began|ends|lasts|of|for|between|cancer)\b""", RegexOption.IGNORE_CASE)
            .containsMatchIn(remainder)
    ) return true
    if (Regex("""\b(?:word|term|character|symbol|key|literal|oxford|trial|billing|grace|menstrual|historical|time)\s+$""", RegexOption.IGNORE_CASE)
            .containsMatchIn(before)
    ) return true
    return offset == 0 && Regex("""^(?:means|is|was|ended|began)\b""", RegexOption.IGNORE_CASE)
        .containsMatchIn(remainder)
}
