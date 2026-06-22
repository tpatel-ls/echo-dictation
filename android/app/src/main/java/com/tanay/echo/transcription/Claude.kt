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
    "You clean up raw speech-to-text dictation transcripts. Fix punctuation and capitalization, " +
        "remove filler words (um, uh, like, you know), remove false starts, stutters and repeated " +
        "words, and format into tidy sentences and paragraphs. Preserve the speaker’s meaning and " +
        "wording faithfully — do NOT summarize, answer, translate, add content, or comment. Return " +
        "ONLY the cleaned transcript text, with no preamble, quotes, or explanation."

@Serializable
private data class ClaudeMessage(val role: String, val content: String)

@Serializable
private data class ClaudeRequest(
    val model: String,
    @SerialName("max_tokens") val maxTokens: Int,
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
    return out.ifEmpty { fallback }
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
    if (!styleDirective.isNullOrBlank()) s += " $styleDirective"
    return s
}

private const val COMMAND_SYSTEM_PROMPT =
    "You are a precise in-place text editor. Apply the user's instruction to the provided text and " +
        "return ONLY the resulting text — no preamble, quotes, or explanation. Preserve the original " +
        "meaning and formatting unless the instruction asks otherwise."

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
    ): String = complete(buildCleanupSystem(glossary, styleDirective), text, text, baseUrl, model, apiKey)

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
            ClaudeRequest(model, 2000, system, listOf(ClaudeMessage("user", userText)))
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
