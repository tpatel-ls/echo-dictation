import { app, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  IPC,
  type AudioMeta,
  type DictationStateEvent,
  type DictionaryEntry,
  type InsertResult,
  type NewTranscript,
  type TranscriptStatus
} from '@shared/types'
import { applyDictionary, buildBiasPrompt } from '@shared/dictionary'
import { registerForTitle, styleDirective } from '@shared/app-style'
import type { SettingsStore } from './store/settings'
import type { HistoryStore } from './store/history'
import type { DictionaryStore } from './store/dictionary'
import { transcribe } from './transcription/whisper'
import { cleanup } from './transcription/claude'
import { pasteText } from './insert/paste'
import { realPasteDeps } from './insert/paste-deps'
import { snapshotForegroundWindow, type WindowSnapshot } from './insert/window-focus'
import { positionOverlay } from './windows'
import { wordCount } from '@shared/format'

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
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private linger: ReturnType<typeof setTimeout> | null = null

  constructor(
    private overlay: BrowserWindow,
    private settings: SettingsStore,
    private history: HistoryStore,
    private dictionary: DictionaryStore
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
    this.pendingFocus = await snapshotForegroundWindow()
  }

  onStop(): void {
    if (!this.busy) return
    this.send({ phase: 'transcribing' })
    this.armWatchdog()
  }

  onCancel(): void {
    this.busy = false
    this.pendingFocus = null
    this.clearWatchdog()
    this.send({ phase: 'idle' })
  }

  async handleAudio(buf: ArrayBuffer, meta: AudioMeta): Promise<InsertResult> {
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

    try {
      const heard = await transcribe(buf, s, sec.whisperApiKey, undefined, {
        prompt: buildBiasPrompt(dict)
      })
      const raw = this.correct(heard, dict)
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
      if (s.cleanupMode === 'auto') {
        try {
          // Context-aware tone: adapt the cleanup register to the focused app (best-effort, from
          // the window title). Neutral titles yield a null directive ⇒ the base cleanup prompt.
          cleaned = await cleanup(
            raw,
            s,
            sec.claudeApiKey,
            undefined,
            dict.map((e) => e.word),
            styleDirective(registerForTitle(appContext))
          )
          text = cleaned
        } catch {
          /* proxy down — fall back to raw text, no failure */
        }
      }

      await pasteText(text, realPasteDeps(this.pendingFocus?.focus))

      const audioPath = s.retainAudio ? saveAudio(buf) : null
      const transcript = this.history.insert(
        row({
          status: 'ok',
          rawText: raw,
          cleanedText: cleaned,
          words: wordCount(text),
          meta,
          appContext,
          model: s.whisperModel,
          latency: Date.now() - t0,
          audioPath
        })
      )
      this.send({ phase: 'inserted', message: preview(text) })
      this.startLinger()
      return { ok: true, transcript }
    } catch (e) {
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
      this.busy = false
      this.pendingFocus = null
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

/** Persist the dictation's WAV to userData/audio when retention is enabled. */
function saveAudio(buf: ArrayBuffer): string | null {
  try {
    const dir = join(app.getPath('userData'), 'audio')
    mkdirSync(dir, { recursive: true })
    const name = `${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`
    const path = join(dir, name)
    writeFileSync(path, Buffer.from(buf))
    return path
  } catch {
    return null
  }
}

function preview(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > 48 ? `${t.slice(0, 48)}…` : t
}

function friendlyError(e: unknown): string {
  const m = (e as Error)?.message ?? 'Transcription failed'
  if (/network|fetch|econn|enotfound|reach|timeout/i.test(m)) return "Can't reach Whisper (Tailscale up?)"
  return m.length > 64 ? `${m.slice(0, 64)}…` : m
}
