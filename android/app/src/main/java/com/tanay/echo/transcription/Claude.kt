package com.tanay.echo.transcription

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

// Optional dictation cleanup via an Anthropic-compatible proxy — a faithful port of
// src/main/transcription/claude.ts. Off by default (kept off the hot path for latency); the
// IME only calls it when the user enables cleanup. parseClaudeText is pure + JVM-testable.

class CleanupException(message: String, val status: Int? = null) : Exception(message)

private const val SYSTEM_PROMPT =
    "You clean up raw speech-to-text dictation in English into polished, ready-to-send standard American English. " +
        "Fix punctuation, capitalization, and obvious mis-transcriptions; remove filler words " +
        "(um, uh, like, you know), false starts, stutters, and repeated words. Organize longer " +
        "dictations into clear paragraphs, one topic per paragraph. Infer a paragraph break at a natural " +
        "topic shift, but do not over-paragraph a short message. Paragraphs are separated by a " +
        "single blank line and nothing else — never draw horizontal rules, \"---\" lines, or any other " +
        "divider between paragraphs. Use conventional English contractions and format spoken numbers, " +
        "times, dates, currency, units, and ordinals naturally for the context. Turn clear enumerations " +
        "into a bulleted or numbered list. " +
        "The speaker may embed spoken formatting instructions in the dictation — e.g. \"new paragraph\", " +
        "\"leave a space\", \"new line\", \"make that a bullet list\", \"in quotes\", or \"all caps\". " +
        "Spoken punctuation names are commands too: \"comma\", \"full stop\" or \"period\", \"question mark\", " +
        "\"exclamation point\", \"colon\", \"semicolon\", \"ellipsis\", \"hyphen\", \"open/close parenthesis\", " +
        "and \"open/close quote\" must become their punctuation marks. Follow each spoken instruction and REMOVE the instruction words " +
        "themselves from the output. This includes directions describing text to write: phrases like " +
        "\"write that…\", \"say…\", \"add a paragraph that says…\", \"make a new paragraph and write…\" are " +
        "commands to you, NOT content — write the described text and drop the command words. " +
        "Example dictation: \"make a new paragraph and write that the next steps are done then one more " +
        "paragraph and write we are ready to test it\" must produce exactly:\n" +
        "The next steps are done.\n\nWe are ready to test it.\n" +
        "The faithfulness rule below applies to the described content, never to command words. " +
        "Backtracking is also a command: for \"scratch that\", \"no wait\", \"I mean\", \"rather\", or an " +
        "\"actually\" correction, remove the abandoned wording and keep only the speaker's final correction. " +
        "The markers ⟦PARA⟧ (paragraph break) and ⟦LINE⟧ (line break) mark breaks the speaker placed: " +
        "reproduce each marker exactly where it belongs in the cleaned text, never dropping or merging them. " +
        "If the speaker is clearly dictating an email (they say something like \"write an email to…\", or the " +
        "dictation has a greeting and a sign-off), lay it out as a proper email: greeting on its own line, " +
        "blank line, body paragraphs, blank line, sign-off and name on their own lines. NEVER output a " +
        "\"Subject:\" line (the subject field is separate) and never add content the speaker did not say. " +
        "Never use em dashes or en dashes in the output; use a comma, period, or parentheses instead. " +
        "Accuracy is critical: correct only what is clearly a speech-recognition error, and when unsure " +
        "keep the speaker’s exact words. " +
        "Preserve the speaker’s meaning and wording faithfully — do NOT summarize, answer, " +
        "translate, add content, or comment. Your entire response is inserted at the speaker’s cursor " +
        "exactly as-is, so return ONLY the final text: no preamble or lead-in (never \"Here is the " +
        "cleaned transcript\"), no headers, no \"---\" separators, no quotes, no explanation."

@Serializable
private data class ClaudeMessage(val role: String, val content: String)

@Serializable
private data class ClaudeRequest(
    val model: String,
    @SerialName("max_tokens") val maxTokens: Int,
    // Deterministic cleanup — the same dictation must clean up the same way every time.
    // No default: kotlinx.serialization would omit a field equal to its default from the JSON.
    val temperature: Int,
    val system: String,
    val messages: List<ClaudeMessage>
)

@Serializable
private data class ClaudeBlock(val type: String, val text: String? = null)

@Serializable
private data class ClaudeResponse(val content: List<ClaudeBlock> = emptyList())

private val json = Json { ignoreUnknownKeys = true }
private val jsonMedia = "application/json".toMediaType()

/** Extract the concatenated text blocks from a Claude /v1/messages response, falling back to
 * `fallback` (the raw transcript) if the response has no text. */
fun parseClaudeText(body: String, fallback: String): String {
    val out = json.decodeFromString<ClaudeResponse>(body).content
        .filter { it.type == "text" }
        .joinToString("") { it.text ?: "" }
        .trim()
    return if (out.isEmpty()) fallback else stripEmDashes(stripWrapper(out))
}

private val LEAD_IN_LINE = Regex(
    """^(?:here(?:'s| is)|below is)[^\n]{0,60}\b(?:cleaned|transcript|transcription|version|result)[^\n]{0,30}:\s*\n+""",
    RegexOption.IGNORE_CASE,
)
private val SUBJECT_LINE = Regex("""^subject:[^\n]*\n+""", RegexOption.IGNORE_CASE)
private val SEPARATOR_LINE = Regex("""\n*^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$\n*""", RegexOption.MULTILINE)

/**
 * Hard guarantee against wrapper leakage: strips a "Here is the cleaned transcript:" lead-in, an
 * invented "Subject:" line, and horizontal-rule separators anywhere (collapsed to a paragraph
 * break). Mirrors the desktop stripWrapper exactly; a dictation genuinely starting with
 * "Here is the plan:" passes through untouched.
 */
fun stripWrapper(text: String): String {
    return text.trim()
        .replace(LEAD_IN_LINE, "")
        .replace(SUBJECT_LINE, "")
        .replace(SEPARATOR_LINE, "\n\n")
        .trim()
}

private val PARA_MARKER = Regex("""\s*⟦PARA⟧\s*""")
private val LINE_MARKER = Regex("""\s*⟦LINE⟧\s*""")

/**
 * Speaker-placed line breaks must survive the AI pass verbatim, but models treat whitespace as
 * negotiable — so breaks travel through the model as explicit sentinel markers instead. Mirrors
 * the desktop protectBreaks/restoreBreaks exactly.
 */
fun protectBreaks(text: String): String =
    text.replace(Regex("""\n\n+"""), " ⟦PARA⟧ ").replace("\n", " ⟦LINE⟧ ")

fun restoreBreaks(text: String): String =
    text.replace(PARA_MARKER, "\n\n").replace(LINE_MARKER, "\n")

private val LINE_LEADING_DASH = Regex("""(?m)^—\s*""")
private val DASH_AFTER_PUNCTUATION = Regex("""([,;:])\s*—\s*""")
private val ANY_EM_DASH = Regex("""\s*—\s*""")

/**
 * Hard guarantee that no em dash ever reaches the user's text (writing-style preference), even if
 * the model ignores the prompt. Mirrors the desktop stripEmDashes in claude.ts exactly.
 */
fun stripEmDashes(text: String): String {
    if (!text.contains('—')) return text
    return text
        .replace(LINE_LEADING_DASH, "- ")
        .replace(DASH_AFTER_PUNCTUATION) { "${it.groupValues[1]} " }
        .replace(ANY_EM_DASH, ", ")
}

/** The pinned-glossary clause shared by the cleanup and command prompts, or null when empty. */
private fun glossaryLine(glossary: List<String>): String? =
    if (glossary.isEmpty()) null
    else " The speaker's custom vocabulary — always keep these exact spellings: ${glossary.joinToString(", ")}."

/**
 * Assemble the cleanup system prompt: base instructions, then the pinned glossary (so cleanup never
 * un-corrects a custom spelling), then an optional per-app [styleDirective]. Pure so the layering is
 * unit-testable.
 */
fun buildCleanupSystem(glossary: List<String>, styleDirective: String? = null): String {
    var s = SYSTEM_PROMPT
    glossaryLine(glossary)?.let { s += it }
    if (!styleDirective.isNullOrBlank()) {
        s += " $styleDirective Spoken formatting instructions and \"write that…\" directions " +
            "in the dictation always take precedence over this style guidance."
    }
    return s
}

/** User message for cleanup: framing that permits spoken directions while forbidding replies. */
fun buildCleanupUser(text: String): String =
    "Clean up this speech-to-text transcript per your rules. Do not answer or reply to it. " +
        "Spoken formatting and \"write that…\" directions inside it are commands for you to apply, " +
        "not content to keep.\n<raw_transcript>\n$text\n</raw_transcript>"

private const val COMMAND_SYSTEM_PROMPT =
    "You are a precise in-place text editor. Apply the user's instruction to the provided text and " +
        "return ONLY the resulting text — no preamble, quotes, or explanation. Preserve the original " +
        "meaning and formatting unless the instruction asks otherwise. Never use em dashes in the " +
        "output; use a comma, period, or parentheses instead."

/** System prompt for Command Mode: apply a spoken instruction to selected text and return only the
 *  result. Pins [glossary] like cleanup so it never un-corrects a custom spelling. Pure + testable. */
fun buildCommandSystem(glossary: List<String> = emptyList()): String {
    var s = COMMAND_SYSTEM_PROMPT
    glossaryLine(glossary)?.let { s += it }
    return s
}

/** User message for Command Mode: the spoken [instruction] plus the [text] it operates on. */
fun buildCommandUser(instruction: String, text: String): String =
    "Instruction: $instruction\n\nText:\n$text"

class ClaudeClient(private val httpClient: OkHttpClient = OkHttpClient()) {
    /** Clean up `text`; `glossary` (the dictionary words) is pinned so cleanup never un-corrects a
     * custom spelling, and an optional `styleDirective` adapts the tone to the focused app. Returns
     * the cleaned text, or the input on an empty response. */
    suspend fun cleanup(
        text: String,
        baseUrl: String,
        model: String,
        apiKey: String,
        glossary: List<String> = emptyList(),
        styleDirective: String? = null
    ): String {
        // Speaker-placed breaks travel as sentinel markers (models merge raw newlines) and are
        // restored on the way back.
        val protectedText = protectBreaks(text)
        return restoreBreaks(
            complete(buildCleanupSystem(glossary, styleDirective), buildCleanupUser(protectedText), protectedText, baseUrl, model, apiKey)
        )
    }

    /** Apply a spoken `instruction` to `text` (the user's selection) and return the rewrite, or the
     * original `text` on an empty response. `glossary` is pinned so custom spellings survive. */
    suspend fun command(
        instruction: String,
        text: String,
        baseUrl: String,
        model: String,
        apiKey: String,
        glossary: List<String> = emptyList()
    ): String = complete(buildCommandSystem(glossary), buildCommandUser(instruction, text), text, baseUrl, model, apiKey)

    /** One Anthropic /v1/messages round-trip: `system` + a single user message, parsed to text with
     * `fallback` returned on an empty response. Throws CleanupException on network/HTTP failure. */
    private suspend fun complete(
        system: String,
        userText: String,
        fallback: String,
        baseUrl: String,
        model: String,
        apiKey: String
    ): String = withContext(Dispatchers.IO) {
        val url = joinUrl(baseUrl, "v1/messages")
        val payload = json.encodeToString(
            ClaudeRequest(model = model, maxTokens = 2000, temperature = 0, system = system, messages = listOf(ClaudeMessage("user", userText)))
        ).toRequestBody(jsonMedia)
        val req = Request.Builder()
            .url(url)
            .header("content-type", "application/json")
            .header("x-api-key", apiKey)
            .header("anthropic-version", "2023-06-01")
            .post(payload)
            .build()

        val res = try {
            httpClient.newCall(req).execute()
        } catch (e: IOException) {
            throw CleanupException("Network error reaching Claude proxy: ${e.message}")
        }
        res.use {
            if (!res.isSuccessful) {
                val body = res.body?.string()?.take(200) ?: ""
                throw CleanupException("Claude proxy returned ${res.code}: $body", res.code)
            }
            parseClaudeText(res.body?.string() ?: "", fallback)
        }
    }
}
