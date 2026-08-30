import { app, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import {
  IPC,
  type AudioMeta,
  type DictationStateEvent,
  type DictionaryEntry,
  type InsertResult,
  type NewTranscript,
  type Secrets,
  type Settings,
  type Transcript,
  type TranscriptStatus
} from '@shared/types'
import { applyDictionary, buildBiasPrompt } from '@shared/dictionary'
import { registerForTitle, styleDirective } from '@shared/app-style'
import { expandSnippet, type Snippet } from '@shared/snippets'
import { applyVoiceCommands } from '@shared/voice-commands'
import type { SettingsStore } from './store/settings'
import type { HistoryStore } from './store/history'
import type { DictionaryStore } from './store/dictionary'
import type { SnippetsStore } from './store/snippets'
import { retainAudioCopy } from './store/history-file'
import { WhisperPrewarm } from './transcription/prewarm'
import { repairTranscriptConsistency } from '@shared/transcript-repair'
import {
  isLowConfidenceRecognitionError,
  recognizeAccurately,
  type SecondaryRecognizer
} from './transcription/accuracy'
import { cleanup, command } from './transcription/claude'
import { pasteText } from './insert/paste'
import { realPasteDeps, realSelectionDeps } from './insert/paste-deps'
import { captureSelection } from './insert/selection'
import { looksLikeTerminal } from './insert/terminal'
import { snapshotForegroundWindow, type WindowSnapshot } from './insert/window-focus'
import { positionOverlay } from './windows'
import { wordCount, needsAiCleanup } from '@shared/format'

const LINGER_MS = 1500
const WATCHDOG_MS = 20_000

/**
 * Owns the live dictation cycle: hotkey down → show pill + snapshot focus, hotkey up →
 * collect audio → transcribe → (optional auto-cleanup) → paste → record + show result.
 * Serializes cycles via `busy` and self-heals via a watchdog if audio never arrives.
 */
export class DictationController {
  private busy = false
  private pendingFocus: WindowSnapshot | null = null
  /** Command Mode: the in-flight selection probe started at hotkey-down. Resolves to the focused
   *  app's selected text, or null when there's nothing selected / command mode is off. */
  private selectionProbe: Promise<string | null> | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private linger: ReturnType<typeof setTimeout> | null = null
  /** Keeps a TLS socket to the Whisper server warm while the user speaks (see prewarm.ts). */
  private prewarm = new WhisperPrewarm()

  constructor(
    private overlay: BrowserWindow,
    private settings: SettingsStore,
    private history: HistoryStore,
    private dictionary: DictionaryStore,
    private snippets: SnippetsStore,
    private secondaryRecognizer?: SecondaryRecognizer
  ) {}

  async onStart(): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.clearLinger()
    // Tell the overlay to start the mic immediately (lowest latency), show the pill,
    // then capture the foreground window in the background — it's only needed later,
    // at paste time, by which point the user is still speaking.
    this.send({ phase: 'listening', startedAt: Date.now() })
    this.show()
    // Warm the Whisper connection while the user speaks so the POST at release skips TLS setup.
    this.prewarm.start(this.settings.getSettings().whisperBaseUrl)
    this.pendingFocus = await snapshotForegroundWindow()
    // Probe the selection now, while the user is still speaking, so it's ready by paste time.
    this.selectionProbe = this.startSelectionProbe()
  }

  /**
   * Command Mode (Wispr-parity): if enabled and Claude is configured, probe the focused app for a
   * selection. A captured selection turns this dictation into a spoken command on it. Skipped for
   * terminals, where a synthetic Ctrl+C is SIGINT (would kill a running process) rather than copy.
   * Returns null — no probe — when any gate fails.
   */
  private startSelectionProbe(): Promise<string | null> | null {
    if (process.platform === 'win32') return null
    const s = this.settings.getSettings()
    const sec = this.settings.getSecrets()
    if (!s.commandModeEnabled) return null
    if (!s.claudeBaseUrl || !sec.claudeApiKey) return null
    if (looksLikeTerminal(this.pendingFocus?.title ?? '')) return null
    return captureSelection(realSelectionDeps())
  }

  onStop(): void {
    if (!this.busy) return
    this.send({ phase: 'transcribing' })
    this.armWatchdog()
  }

  onCancel(): void {
    this.prewarm.stop()
    this.busy = false
    this.pendingFocus = null
    this.selectionProbe = null
    this.clearWatchdog()
    this.send({ phase: 'idle' })
  }

  async handleAudio(buf: ArrayBuffer, meta: AudioMeta): Promise<InsertResult> {
    this.prewarm.stop()
    this.clearWatchdog()
    const t0 = Date.now()
    const s = this.settings.getSettings()
    const sec = this.settings.getSecrets()
    const appContext = this.pendingFocus?.title ?? 'Unknown'

    // Personal dictionary — failures here must never break dictation itself.
    let dict: DictionaryEntry[] = []
    try {
      dict = this.dictionary.list()
    } catch {
      /* dictation works fine without the dictionary */
    }

    let snippets: Snippet[] = []
    try {
      snippets = this.snippets.list()
    } catch {
      /* dictation works fine without snippets */
    }

    let tempAudioPath: string | null = null
    try {
      tempAudioPath = writeTemporaryAudio(buf)
      const glossary = dict.map((e) => e.word)
      const speculativeCleanup: {
        current: { raw: string; result: Promise<string | null> } | null
      } = { current: null }
      const onPrimary = (candidate: { text: string }): void => {
        if (
          speculativeCleanup.current ||
          s.cleanupMode !== 'auto' ||
          this.selectionProbe !== null ||
          !s.claudeBaseUrl ||
          !sec.claudeApiKey
        ) {
          return
        }
        const previewRaw = prepareTranscriptText(candidate.text, dict)
        if (!previewRaw || !needsAiCleanup(previewRaw)) return
        // Start formatting as soon as the first decode lands. A caught promise makes this safe
        // even when a recovery candidate later wins and the speculative result is discarded.
        speculativeCleanup.current = {
          raw: previewRaw,
          result: cleanup(
            previewRaw,
            s,
            sec.claudeApiKey,
            undefined,
            glossary,
            styleDirective(registerForTitle(appContext))
          ).catch(() => null)
        }
      }
      const outcome = await recognizeAccurately({
        path: tempAudioPath,
        buffer: buf,
        durationMs: meta.durationMs
      }, {
        settings: s,
        whisperApiKey: sec.whisperApiKey,
        claudeApiKey: sec.claudeApiKey,
        appContext,
        glossary,
        prompt: buildBiasPrompt(dict)
      }, {
        secondary: this.secondaryRecognizer,
        onPrimary
      })
      const heard = outcome.winner.text

      // Command Mode: a selection captured at hotkey-down means this utterance is a spoken
      // instruction on that selection, not text to insert. Nothing selected ⇒ normal dictation.
      const selection = this.selectionProbe ? await this.selectionProbe : null
      if (selection !== null) {
        return await this.runCommand(selection, heard, s, sec, dict)
      }

      // Dictionary guarantees custom spellings; spoken formatting commands ("new paragraph",
      // "leave space", "new line") become real breaks instantly, before any AI pass.
      const raw = applyVoiceCommands(repairTranscriptConsistency(this.correct(heard, dict)))
      if (!raw) {
        this.history.insert(
          row({ status: 'empty', meta, appContext, model: s.whisperModel, latency: Date.now() - t0 })
        )
        this.send({ phase: 'empty', message: 'No speech detected' })
        this.startLinger()
        return { ok: false, error: 'empty' }
      }

      let text = raw
      let cleaned: string | null = null
      // A voice snippet (the whole utterance matches a cue) pastes its saved block as-is, no cleanup.
      const expansion = expandSnippet(raw, snippets)
      if (expansion !== null) {
        text = expansion
      } else if (
        s.cleanupMode === 'auto' &&
        outcome.winner.source !== 'adjudicated' &&
        needsAiCleanup(raw)
      ) {
        // (short dictations Whisper already punctuated cleanly skip the AI pass — instant insert)
        try {
          // Context-aware tone: adapt the cleanup register to the focused app (best-effort, from
          // the window title). Neutral titles yield a null directive ⇒ the base cleanup prompt.
          cleaned =
            speculativeCleanup.current?.raw === raw
              ? await speculativeCleanup.current.result
              : await cleanup(
                  raw,
                  s,
                  sec.claudeApiKey,
                  undefined,
                  glossary,
                  styleDirective(registerForTitle(appContext))
                )
          if (cleaned) text = cleaned
        } catch {
          /* proxy down — fall back to raw text, no failure */
        }
      }

      await pasteText(text, realPasteDeps(this.pendingFocus?.focus))

      const audioPath = s.retainAudio && tempAudioPath ? retainAudioCopy(tempAudioPath) : null
      const transcript = this.history.insert(
        row({
          status: 'ok',
          rawText: raw,
          cleanedText: cleaned,
          words: wordCount(text),
          meta,
          appContext,
          model: outcome.winner.source,
          latency: Date.now() - t0,
          audioPath
        })
      )
      this.send({ phase: 'inserted', message: preview(text) })
      this.startLinger()
      return { ok: true, transcript }
    } catch (e) {
      if (isLowConfidenceRecognitionError(e)) {
        const reason = 'Low confidence transcription'
        const audioPath = s.retainAudio && tempAudioPath ? retainAudioCopy(tempAudioPath) : null
        this.history.insert(
          row({ status: 'failed', rawText: reason, meta, appContext, model: 'low-confidence', latency: Date.now() - t0, audioPath })
        )
        this.send({ phase: 'error', message: reason })
        this.startLinger()
        return { ok: false, error: (e as Error).message }
      }
      const reason = friendlyError(e)
      this.history.insert(
        row({ status: 'failed', rawText: reason, meta, appContext, model: s.whisperModel, latency: Date.now() - t0 })
      )
      this.send({ phase: 'error', message: reason })
      this.startLinger()
      return { ok: false, error: (e as Error).message }
    } finally {
      this.busy = false
      this.pendingFocus = null
      this.selectionProbe = null
      if (tempAudioPath) deleteTemporaryAudio(tempAudioPath)
    }
  }

  async retryTranscript(id: number): Promise<Transcript> {
    const existing = this.history.get(id)
    if (!existing) throw new Error('Transcript not found')
    if (!existing.audio_path || !existsSync(existing.audio_path)) throw new Error('Retained audio is unavailable')

    const started = Date.now()
    const s = this.settings.getSettings()
    const sec = this.settings.getSecrets()
    const dict = this.dictionary.list()
    const glossary = dict.map((entry) => entry.word)
    const file = readFileSync(existing.audio_path)
    const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
    const outcome = await recognizeAccurately(
      { path: existing.audio_path, buffer, durationMs: existing.duration_ms },
      {
        settings: s,
        whisperApiKey: sec.whisperApiKey,
        claudeApiKey: sec.claudeApiKey,
        appContext: existing.app_context,
        glossary,
        prompt: buildBiasPrompt(dict)
      },
      { secondary: this.secondaryRecognizer }
    )

    const raw = applyVoiceCommands(this.correct(outcome.winner.text, dict))
    if (!raw) throw new Error('No speech detected')
    let cleaned: string | null = null
    if (s.cleanupMode === 'auto' && needsAiCleanup(raw)) {
      try {
        cleaned = await cleanup(
          raw,
          s,
          sec.claudeApiKey,
          undefined,
          glossary,
          styleDirective(registerForTitle(existing.app_context))
        )
      } catch {
        /* keep the recovered raw transcript */
      }
    }

    const updated = this.history.updateRetried(id, {
      rawText: raw,
      cleanedText: cleaned,
      model: outcome.winner.source,
      latencyMs: Date.now() - started
    })
    if (!updated) throw new Error('Transcript not found')
    return updated
  }

  /**
   * Command Mode: apply the spoken `heard` instruction to the captured `selection` and paste the
   * rewrite over it (Ctrl+V replaces the still-active selection). Non-destructive — an empty
   * instruction or any failure pastes nothing, so the selection is never clobbered. Not recorded to
   * history (it's an in-place edit, not a capture), matching Android.
   */
  private async runCommand(
    selection: string,
    heard: string,
    s: Settings,
    sec: Secrets,
    dict: DictionaryEntry[]
  ): Promise<InsertResult> {
    const instruction = heard.trim()
    if (!instruction) {
      this.send({ phase: 'empty', message: 'No command heard' })
      this.startLinger()
      return { ok: false, error: 'empty' }
    }
    try {
      const rewrite = await command(
        selection,
        instruction,
        s,
        sec.claudeApiKey,
        undefined,
        dict.map((e) => e.word)
      )
      await pasteText(rewrite, realPasteDeps(this.pendingFocus?.focus))
      this.send({ phase: 'inserted', message: preview(rewrite) })
      this.startLinger()
      return { ok: true }
    } catch (e) {
      this.send({ phase: 'error', message: friendlyError(e, 'Claude') })
      this.startLinger()
      return { ok: false, error: (e as Error).message }
    }
  }

  /** Deterministic replacement layer — guarantees known corrections, never throws. */
  private correct(text: string, dict: DictionaryEntry[]): string {
    if (!text || !dict.length) return text
    try {
      const { text: corrected, appliedIds } = applyDictionary(text, dict)
      if (appliedIds.length) this.dictionary.recordApplied(appliedIds)
      return corrected
    } catch {
      return text
    }
  }

  private show(): void {
    if (this.overlay.isDestroyed()) return
    positionOverlay(this.overlay, this.settings.getSettings().overlayOffsetBottom)
    this.overlay.showInactive()
  }

  private send(e: DictationStateEvent): void {
    if (!this.overlay.isDestroyed()) this.overlay.webContents.send(IPC.DICTATION_STATE, e)
    if (e.phase === 'idle' && !this.overlay.isDestroyed()) this.overlay.hide()
  }

  private startLinger(): void {
    this.clearLinger()
    this.linger = setTimeout(() => this.send({ phase: 'idle' }), LINGER_MS)
  }
  private clearLinger(): void {
    if (this.linger) {
      clearTimeout(this.linger)
      this.linger = null
    }
  }
  private armWatchdog(): void {
    this.clearWatchdog()
    this.watchdog = setTimeout(() => {
      this.prewarm.stop()
      this.busy = false
      this.pendingFocus = null
      this.selectionProbe = null
      this.send({ phase: 'error', message: 'Timed out' })
      this.startLinger()
    }, WATCHDOG_MS)
  }
  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }
  }
}

interface RowParams {
  status: TranscriptStatus
  meta: AudioMeta
  appContext: string
  model: string
  latency: number
  rawText?: string
  cleanedText?: string | null
  words?: number
  audioPath?: string | null
}

function row(p: RowParams): NewTranscript {
  return {
    created_at: Date.now(),
    raw_text: p.rawText ?? '',
    cleaned_text: p.cleanedText ?? null,
    duration_ms: p.meta.durationMs,
    word_count: p.words ?? 0,
    latency_ms: p.latency,
    app_context: p.appContext,
    model: p.model,
    status: p.status,
    audio_path: p.audioPath ?? null
  }
}

/** Write exactly one temporary WAV for recognizers that need a filesystem path. */
function writeTemporaryAudio(buf: ArrayBuffer): string {
  const dir = join(app.getPath('temp'), 'echo-dictation')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`)
  writeFileSync(path, Buffer.from(buf))
  return path
}

function deleteTemporaryAudio(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* temp cleanup is best-effort */
  }
}

function preview(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > 48 ? `${t.slice(0, 48)}…` : t
}

/** Apply the deterministic text layer without mutating dictionary usage counters. */
function prepareTranscriptText(text: string, dict: DictionaryEntry[]): string {
  let corrected = text
  if (text && dict.length) {
    try {
      corrected = applyDictionary(text, dict).text
    } catch {
      corrected = text
    }
  }
  return applyVoiceCommands(repairTranscriptConsistency(corrected))
}

function friendlyError(e: unknown, service = 'Whisper'): string {
  const m = (e as Error)?.message ?? 'Transcription failed'
  if (/network|fetch|econn|enotfound|reach|timeout/i.test(m)) return `Can't reach ${service} (Tailscale up?)`
  return m.length > 64 ? `${m.slice(0, 64)}…` : m
}
