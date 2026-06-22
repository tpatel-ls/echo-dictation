package com.tanay.echo.transcription

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

// Whisper transcription client — a faithful Kotlin port of src/main/transcription/whisper.ts,
// including its retry/timeout policy. parseWhisperText + joinUrl are pure (JVM-testable); the
// OkHttp client is exercised end-to-end against MockWebServer in WhisperTest (also JVM).

class TranscriptionException(message: String, val status: Int? = null) : Exception(message)

@Serializable
private data class WhisperResponse(val text: String? = null)

private val json = Json { ignoreUnknownKeys = true }

/** Parse an OpenAI-compatible /audio/transcriptions JSON body → trimmed text. */
fun parseWhisperText(body: String): String =
    (json.decodeFromString<WhisperResponse>(body).text ?: "").trim()

fun joinUrl(base: String, path: String): String =
    base.trimEnd('/') + "/" + path.trimStart('/')

/** The Whisper `language` form value, or null to let Whisper auto-detect. Blank or "auto" ⇒ null. */
fun languageParam(raw: String): String? {
    val v = raw.trim().lowercase()
    return if (v.isEmpty() || v == "auto") null else v
}

/**
 * POST a WAV to an OpenAI-compatible `/audio/transcriptions` endpoint and return the text.
 * Retries transient failures (network errors, 5xx) so a momentary tailnet blip doesn't lose
 * a dictation; never retries a real 4xx — except that, since the bias prompt is the most
 * likely thing a server rejects, it drops the prompt and tries once more before giving up.
 * `httpClient` and `sleep` are injectable so the whole policy is unit-testable.
 */
class WhisperClient(
    private val httpClient: OkHttpClient = OkHttpClient(),
    private val sleep: suspend (Long) -> Unit = { delay(it) }
) {
    suspend fun transcribe(
        wav: ByteArray,
        baseUrl: String,
        model: String,
        apiKey: String,
        prompt: String? = null,
        language: String? = null,
        retries: Int = 2,
        timeoutMs: Long = 20_000
    ): String {
        val url = joinUrl(baseUrl, "audio/transcriptions")
        var currentPrompt = prompt?.takeIf { it.isNotEmpty() }
        var lastError: TranscriptionException? = null
        var attempt = 0
        while (attempt <= retries) {
            try {
                return postOnce(url, wav, model, apiKey, currentPrompt, language, timeoutMs)
            } catch (e: TranscriptionException) {
                lastError = e
                // 4xx is a real client error (bad key/request) — retrying won't help. But the
                // optional bias prompt may be what the server rejects, so try once more without
                // it before giving up (does not consume a retry).
                if (e.status != null && e.status in 400..499) {
                    if (currentPrompt != null) {
                        currentPrompt = null
                        continue
                    }
                    throw e
                }
                if (attempt < retries) sleep(250L * (attempt + 1))
            }
            attempt++
        }
        throw lastError ?: TranscriptionException("Whisper transcription failed")
    }

    private suspend fun postOnce(
        url: String,
        wav: ByteArray,
        model: String,
        apiKey: String,
        prompt: String?,
        language: String?,
        timeoutMs: Long
    ): String = withContext(Dispatchers.IO) {
        val form = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", "audio.wav", wav.toRequestBody("audio/wav".toMediaType()))
            .addFormDataPart("model", model)
            .addFormDataPart("response_format", "json")
            .apply { if (prompt != null) addFormDataPart("prompt", prompt) }
            .apply { if (!language.isNullOrEmpty()) addFormDataPart("language", language) }
            .build()
        val req = Request.Builder().url(url).header("Authorization", "Bearer $apiKey").post(form).build()
        val call = httpClient.newBuilder().callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build().newCall(req)

        val res = try {
            call.execute()
        } catch (e: IOException) {
            throw TranscriptionException("Network error reaching Whisper: ${e.message}")
        }
        res.use {
            if (!res.isSuccessful) {
                val body = try { res.body?.string() ?: "" } catch (e: IOException) { "" }
                throw TranscriptionException("Whisper returned ${res.code}: ${body.take(200)}", res.code)
            }
            parseWhisperText(res.body?.string() ?: "")
        }
    }
}
