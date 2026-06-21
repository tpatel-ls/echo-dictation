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

class ClaudeClient(private val httpClient: OkHttpClient = OkHttpClient()) {
    /** Clean up `text`; `glossary` (the dictionary words) is pinned so cleanup never un-corrects
     * a custom spelling. Returns the cleaned text, or the input on an empty response. */
    suspend fun cleanup(
        text: String,
        baseUrl: String,
        model: String,
        apiKey: String,
        glossary: List<String> = emptyList()
    ): String = withContext(Dispatchers.IO) {
        val url = joinUrl(baseUrl, "v1/messages")
        val system = if (glossary.isEmpty()) {
            SYSTEM_PROMPT
        } else {
            "$SYSTEM_PROMPT The speaker's custom vocabulary — always keep these exact spellings: ${glossary.joinToString(", ")}."
        }
        val payload = json.encodeToString(
            ClaudeRequest(model, 2000, system, listOf(ClaudeMessage("user", text)))
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
            parseClaudeText(res.body?.string() ?: "", text)
        }
    }
}
