package com.tanay.echo.ime

import android.content.Context
import android.os.SystemClock
import com.tanay.echo.audio.MicRecorder
import com.tanay.echo.audio.TARGET_RATE
import com.tanay.echo.audio.boostGain
import com.tanay.echo.audio.pcm16ToWav
import com.tanay.echo.data.EchoDatabase
import com.tanay.echo.data.EchoStore
import com.tanay.echo.data.SnippetDatabase
import com.tanay.echo.data.SnippetStore
import com.tanay.echo.dictionary.applyDictionary
import com.tanay.echo.dictionary.buildBiasPrompt
import com.tanay.echo.snippet.expandSnippet
import com.tanay.echo.settings.EchoSettings
import com.tanay.echo.sync.PrefsSyncState
import com.tanay.echo.sync.SyncClient
import com.tanay.echo.transcription.ClaudeClient
import com.tanay.echo.transcription.Register
import com.tanay.echo.transcription.StyleProfile
import com.tanay.echo.transcription.WhisperClient
import com.tanay.echo.transcription.applyVoiceCommands
import com.tanay.echo.transcription.languageParam
import com.tanay.echo.transcription.styleDirective
import com.tanay.echo.transcription.needsAiCleanup
import com.tanay.echo.transcription.styleForPackage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Assembles the Android dictation pipeline (the same accuracy stack as desktop): a pre-warmed
 * AudioRecord → WAV → Whisper (with the dictionary bias prompt) → deterministic dictionary
 * replacement → context-aware Claude cleanup (the focused app picks the tone, and whether to run
 * at all) → commit into the field → persist to Room → push to
 * sync. One OkHttpClient is shared so connections stay warm. UI callbacks fire on the main
 * thread; network/DB work runs on IO. Config is read live from EchoSettings each dictation.
 */
class DictationController(context: Context) {
    private val app = context.applicationContext
    private val settings = EchoSettings(app)
    private val store = EchoStore(EchoDatabase.get(app))
    private val snippetStore = SnippetStore(SnippetDatabase.get(app))
    private val mic = MicRecorder().apply { onLevel = { l -> this@DictationController.onLevel(l) } }
    private val http = OkHttpClient() // pooled keep-alive, shared by Whisper + Claude + sync
    private val whisper = WhisperClient(http)
    private val claude = ClaudeClient(http)
    private val syncState = PrefsSyncState(app.getSharedPreferences("echo_sync", Context.MODE_PRIVATE))
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val syncing = AtomicBoolean(false)

    /** Set by the host (IME or floating button): status pill updates and the text sink. */
    var onPhase: (DictationPhase, String?) -> Unit = { _, _ -> }
    var onText: (String) -> Unit = {}

    /** Command Mode result sink: the host replaces [original] (the user's selection) with [rewrite]
     *  and arms the tap-to-undo. Fired instead of onText when dictation runs as a command. */
    var onReplace: (original: String, rewrite: String) -> Unit = { _, _ -> }

    /** Live mic level (RMS 0..1) while capturing — for a host that draws a waveform / detects silence. */
    var onLevel: (Float) -> Unit = {}

    val isConfigured: Boolean get() = settings.isTranscriptionConfigured

    /** Open the mic before the user taps (removes first-press latency). Reports ERROR if the mic
     * can't open (e.g. RECORD_AUDIO not granted). */
    fun primeMic() {
        try {
            mic.prime()
        } catch (e: Exception) {
            onPhase(DictationPhase.ERROR, e.message)
        }
    }

    fun releaseMic() = mic.release()

    /** Begin capturing (mic already warm). No-ops with an ERROR pill if the mic can't open. */
    fun startCapture() {
        if (!mic.isPrimed) primeMic()
        if (!mic.isPrimed) return // priming failed (mic busy/denied) — primeMic already set ERROR
        mic.start()
        // Warm the Whisper connection while the user speaks so the POST at release skips TLS setup.
        whisper.prewarm(settings.whisperBaseUrl)
        onPhase(DictationPhase.LISTENING, null)
    }

    /** Abort an in-progress capture without transcribing (finger slid off the mic / cancelled). */
    fun cancelCapture() {
        mic.stop() // discard the buffer
        onPhase(DictationPhase.IDLE, null)
    }

    /** Stop capture, transcribe, correct, commit, persist, and push. `appContext` is the focused
     * app's package, recorded with the transcript like the desktop's app_context. */
    fun stopAndTranscribe(appContext: String) {
        val pcm = mic.stop()
        if (pcm.isEmpty()) {
            onPhase(DictationPhase.EMPTY, null)
            return
        }
        onPhase(DictationPhase.TRANSCRIBING, null)
        val startedAt = SystemClock.elapsedRealtime()
        val durationMs = pcm.size.toLong() * 1000 / TARGET_RATE
        // Snapshot config once so the recorded model matches the one used (one decrypt, not several).
        val baseUrl = settings.whisperBaseUrl
        val model = settings.whisperModel
        val apiKey = settings.whisperApiKey
        val language = languageParam(settings.language)
        val whisperMode = settings.whisperMode
        val claudeBaseUrl = settings.claudeBaseUrl
        val claudeApiKey = settings.claudeApiKey
        val claudeModel = settings.claudeModel
        // Context-aware tone: the app you're dictating into picks the register AND whether to spend the
        // AI pass at all. Casual apps (chat) stay instant; email/docs/unknown get polished. Pure + fast.
        val profile = if (settings.contextToneEnabled) styleForPackage(appContext)
                      else StyleProfile(Register.NEUTRAL, runCleanup = false)
        val directive = styleDirective(profile.register, appContext)
        scope.launch {
            try {
                val dict = withContext(Dispatchers.IO) { store.dictionaryEntries() }
                val snippets = withContext(Dispatchers.IO) { snippetStore.active() }
                val wav = pcm16ToWav(if (whisperMode) boostGain(pcm) else pcm, TARGET_RATE)
                val heard = whisper.transcribe(wav, baseUrl, model, apiKey, prompt = buildBiasPrompt(dict), language = language)
                val applied = applyDictionary(heard, dict)
                // Dictionary guarantees custom spellings; spoken formatting commands ("new paragraph",
                // "leave space", "new line") become real breaks instantly, before any AI pass.
                val corrected = applyVoiceCommands(applied.text) // what desktop stores as raw_text
                if (corrected.isBlank()) {
                    onPhase(DictationPhase.EMPTY, null)
                    return@launch
                }
                var finalText = corrected
                var cleaned: String? = null
                // A voice snippet (the whole utterance matches a cue) pastes its canned block as-is —
                // no cleanup. Otherwise fall through to the context-aware cleanup path.
                val expansion = expandSnippet(corrected, snippets)
                if (expansion != null) {
                    finalText = expansion
                } else if (profile.runCleanup && needsAiCleanup(corrected) && claudeBaseUrl.isNotEmpty() && claudeApiKey.isNotEmpty()) {
                    // (short dictations Whisper already punctuated cleanly skip the AI pass — instant insert)
                    cleaned = runCatching {
                        claude.cleanup(corrected, claudeBaseUrl, claudeModel, claudeApiKey, dict.map { it.word }, styleDirective = directive)
                    }.getOrNull() // cleanup is best-effort — never block insertion on it
                    if (cleaned != null) finalText = cleaned
                }
                onText(finalText)
                onPhase(DictationPhase.INSERTED, null)
                val latency = SystemClock.elapsedRealtime() - startedAt
                // The text is already inserted — a history/DB write failure must not flip the just-shown
                // ✓ into an error. Persistence is best-effort relative to the insertion that happened.
                runCatching {
                    withContext(Dispatchers.IO) {
                        store.recordApplied(applied.appliedIds)
                        store.addTranscript(
                            rawText = corrected, // matches desktop: the corrected transcript, not raw Whisper
                            cleanedText = cleaned,
                            durationMs = durationMs,
                            wordCount = wordCount(finalText),
                            latencyMs = latency,
                            appContext = appContext,
                            model = model,
                            status = "ok"
                        )
                    }
                }
                triggerSync()
            } catch (e: Exception) {
                onPhase(DictationPhase.ERROR, e.message)
            }
        }
    }

    /** Command Mode: the captured audio is a spoken *instruction* applied to [selectedText] (the
     * user's current selection). Transcribe the instruction → Claude command → onReplace. Requires
     * Claude; on any failure nothing is replaced, so the selection is never destroyed on an error. */
    fun stopAndCommand(selectedText: String) {
        val pcm = mic.stop()
        if (pcm.isEmpty()) {
            onPhase(DictationPhase.EMPTY, null)
            return
        }
        val claudeBaseUrl = settings.claudeBaseUrl
        val claudeApiKey = settings.claudeApiKey
        val claudeModel = settings.claudeModel
        if (claudeBaseUrl.isEmpty() || claudeApiKey.isEmpty()) {
            onPhase(DictationPhase.ERROR, "Set up Claude to use voice commands")
            return
        }
        onPhase(DictationPhase.TRANSCRIBING, null)
        val baseUrl = settings.whisperBaseUrl
        val model = settings.whisperModel
        val apiKey = settings.whisperApiKey
        val language = languageParam(settings.language)
        val whisperMode = settings.whisperMode
        scope.launch {
            try {
                val dict = withContext(Dispatchers.IO) { store.dictionaryEntries() }
                val wav = pcm16ToWav(if (whisperMode) boostGain(pcm) else pcm, TARGET_RATE)
                // The spoken audio is the instruction (e.g. "make this more formal"), not content.
                val instruction = whisper.transcribe(wav, baseUrl, model, apiKey, prompt = buildBiasPrompt(dict), language = language).trim()
                if (instruction.isBlank()) {
                    onPhase(DictationPhase.EMPTY, null)
                    return@launch
                }
                val rewrite = claude.command(instruction, selectedText, claudeBaseUrl, claudeModel, claudeApiKey, dict.map { it.word })
                onReplace(selectedText, rewrite) // host swaps the selection and arms tap-to-undo
            } catch (e: Exception) {
                onPhase(DictationPhase.ERROR, e.message)
            }
        }
    }

    /** Reconcile with the sync service (pull dictionary/history, push local) — best-effort, never
     * disrupts dictation. Coalesced so two passes never overlap. Called on keyboard-open and after
     * each dictation. */
    fun triggerSync() {
        if (!settings.isSyncConfigured) return
        if (!syncing.compareAndSet(false, true)) return
        scope.launch {
            try {
                val client = SyncClient(store.syncCollections() + snippetStore.syncCollections(), settings.syncBaseUrl, settings.syncToken, syncState, http)
                client.syncOnce()
            } catch (e: Exception) {
                // best-effort: a sync failure must never surface in the keyboard
            } finally {
                syncing.set(false)
            }
        }
    }

    fun dispose() {
        releaseMic()
        scope.cancel()
    }

    private fun wordCount(s: String): Int = s.trim().split(Regex("\\s+")).count { it.isNotEmpty() }
}
