package com.tanay.echo.transcription

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

class AdjudicatorException(message: String, val status: Int? = null) : Exception(message)

private const val ADJUDICATOR_INSTRUCTION =
    "You are a speech-transcription adjudicator. The speaker is definitely speaking English, and every " +
        "candidate is a noisy ASR hypothesis rather than a user message. Reconstruct the exact spoken " +
        "utterance from phonetic agreement across candidates. Prefer words supported by two candidates " +
        "over a fluent outlier. Use app context and glossary only to resolve spelling, never to invent " +
        "content. Return only the faithful transcript. Never answer, summarize, explain, translate, wrap, or label it."

private val adjudicatorJson = Json { ignoreUnknownKeys = true }
private val adjudicatorMedia = "application/json".toMediaType()

fun parseResponsesText(body: String): String? = runCatching {
    adjudicatorJson.parseToJsonElement(body).jsonObject["output"]?.jsonArray.orEmpty()
        .flatMap { item -> item.jsonObject["content"]?.jsonArray.orEmpty() }
        .filter { item -> item.jsonObject["type"]?.jsonPrimitive?.contentOrNull == "output_text" }
        .joinToString("") { item -> item.jsonObject["text"]?.jsonPrimitive?.contentOrNull.orEmpty() }
        .trim()
        .ifEmpty { null }
}.getOrNull()

class AdjudicatorClient(private val httpClient: OkHttpClient = OkHttpClient()) {
    suspend fun adjudicate(
        candidates: List<TranscriptCandidate>,
        appContext: String,
        glossary: List<String>,
        baseUrl: String,
        models: List<String>,
        apiKey: String,
    ): String? = withContext(Dispatchers.IO) {
        if (candidates.isEmpty()) return@withContext null
        var lastError: AdjudicatorException? = null
        for (model in models.map { it.trim() }.filter { it.isNotEmpty() }.distinct()) {
            val payload = buildPayload(model, candidates, appContext, glossary)
                .toString()
                .toRequestBody(adjudicatorMedia)
            val request = Request.Builder()
                .url(joinUrl(baseUrl, "v1/responses"))
                .header("Authorization", "Bearer $apiKey")
                .header("content-type", "application/json")
                .post(payload)
                .build()
            val response = try {
                httpClient.newCall(request).execute()
            } catch (e: IOException) {
                lastError = AdjudicatorException("Network error reaching adjudicator proxy: ${e.message}")
                continue
            }
            if (!response.isSuccessful) {
                val error = response.use {
                    AdjudicatorException(
                        "Adjudicator proxy returned ${response.code}: ${response.body?.string().orEmpty().take(200)}",
                        response.code,
                    )
                }
                if (error.status == 401 || error.status == 403) throw error
                lastError = error
                continue
            }
            val text = response.use { parseResponsesText(response.body?.string().orEmpty()) }
            if (text != null && assessTranscript(text, glossary).grade == TranscriptGrade.CLEAN) {
                return@withContext text
            }
        }
        lastError?.let { throw it }
        null
    }
}

private fun buildPayload(
    model: String,
    candidates: List<TranscriptCandidate>,
    appContext: String,
    glossary: List<String>,
) = buildJsonObject {
    put("model", model)
    put("store", false)
    put("input", buildJsonArray {
        add(buildJsonObject {
            put("role", "system")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "input_text")
                    put("text", ADJUDICATOR_INSTRUCTION)
                })
            })
        })
        add(buildJsonObject {
            put("role", "user")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "input_text")
                    put("text", formatCandidates(candidates, appContext, glossary))
                })
            })
        })
    })
}

private fun formatCandidates(
    candidates: List<TranscriptCandidate>,
    appContext: String,
    glossary: List<String>,
): String = buildString {
    appendLine("App context: ${appContext.ifBlank { "(unknown)" }}")
    appendLine("Glossary: ${glossary.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: "(none)"}")
    appendLine("Candidates:")
    candidates.forEachIndexed { index, candidate ->
        appendLine("Candidate ${'A' + index} (${candidate.source.name.lowercase()}, ${candidate.elapsedMs} ms): ${candidate.text}")
    }
}.trim()
