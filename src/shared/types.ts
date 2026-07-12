// ─────────────────────────────────────────────────────────────────────────────
// Shared types — the single source of truth referenced by main, preload, renderers.
// ─────────────────────────────────────────────────────────────────────────────

export type TranscriptStatus = 'ok' | 'failed' | 'empty'

export interface Transcript {
  id: number
  created_at: number // epoch ms
  raw_text: string
  cleaned_text: string | null
  duration_ms: number
  word_count: number
  latency_ms: number
  app_context: string
  model: string
  status: TranscriptStatus
  audio_path: string | null
}

export type NewTranscript = Omit<Transcript, 'id'>

export type CleanupMode = 'off' | 'auto' | 'on-demand'
export type MicMode = 'on-demand' | 'warm'
export type AccuracyMode = 'fast' | 'balanced' | 'maximum'
export type TriggerKey =
  | 'RightControl'
  | 'LeftControl'
  | 'RightCommand' // ⌘
  | 'LeftCommand'
  | 'EitherOption' // either ⌥ key
  | 'LeftOption'
  | 'RightOption' // ⌥
  | 'CapsLock'
  | 'F8'

/** Host operating system, surfaced to the renderer so the UI can adapt (e.g. which
 * trigger keys exist on this machine). */
export type OSPlatform = 'darwin' | 'win32' | 'linux'

export interface Settings {
  triggerKey: TriggerKey
  minHoldMs: number
  cancelOnOtherKey: boolean
  whisperBaseUrl: string
  whisperModel: string
  cleanupMode: CleanupMode
  accuracyMode: AccuracyMode
  claudeBaseUrl: string
  claudeModel: string
  accuracyModel: string
  /** Command Mode: when text is selected, treat a dictation as a spoken instruction on it (needs Claude). */
  commandModeEnabled: boolean
  launchAtLogin: boolean
  micMode: MicMode
  /** Per-user preferred microphone device id. Empty follows the macOS system default. */
  audioInputDeviceId: string
  retainAudio: boolean
  insertMode: 'paste'
  overlayOffsetBottom: number
  /** Base URL of the self-hosted sync service (tailnet). Empty disables sync. */
  syncBaseUrl: string
}

export const DEFAULT_SETTINGS: Settings = {
  triggerKey: 'EitherOption',
  minHoldMs: 200,
  cancelOnOtherKey: true,
  // Point these at your own endpoints in Settings (any OpenAI-compatible
  // /audio/transcriptions server; any Anthropic-compatible /v1/messages proxy).
  whisperBaseUrl: '',
  whisperModel: 'whisper-1',
  cleanupMode: 'auto',
  accuracyMode: 'maximum',
  claudeBaseUrl: '',
  claudeModel: 'claude-sonnet-4-6',
  accuracyModel: 'gpt-5.4-mini',
  commandModeEnabled: false,
  launchAtLogin: true,
  micMode: 'on-demand',
  audioInputDeviceId: '',
  retainAudio: true,
  insertMode: 'paste',
  overlayOffsetBottom: 28,
  syncBaseUrl: ''
}

export interface Secrets {
  whisperApiKey: string
  claudeApiKey: string
  /** Bearer token shared with the sync service. Empty disables sync. */
  syncToken: string
}

export const EMPTY_SECRETS: Secrets = {
  whisperApiKey: '',
  claudeApiKey: '',
  syncToken: ''
}

// ── Dictation state (main → overlay) ─────────────────────────────────────────

export type DictationPhase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'inserted'
  | 'empty'
  | 'error'

export interface DictationStateEvent {
  phase: DictationPhase
  message?: string
  startedAt?: number
}

export interface AudioMeta {
  durationMs: number
  sampleRate: number
}

export interface InsertResult {
  ok: boolean
  transcript?: Transcript
  error?: string
}

// ── Dictionary ───────────────────────────────────────────────────────────────

export type DictionarySource = 'manual' | 'learned'

export interface DictionaryEntry {
  id: number
  word: string // canonical spelling, e.g. "Bryan"
  misheard: string[] // aliases Whisper produces, e.g. ["Brian"]
  source: DictionarySource
  created_at: number // epoch ms
  times_applied: number
}

/** One auto-learned correction from a transcript edit — enough info to undo it. */
export interface LearnedCorrection {
  entryId: number
  from: string
  to: string
  createdEntry: boolean // true: undo deletes the entry; false: undo removes just the alias
}

export interface EditResult {
  transcript: Transcript
  learned: LearnedCorrection[]
}

// ── Stats ────────────────────────────────────────────────────────────────────

export interface Stats {
  totalWords: number
  totalTranscripts: number
  todayWords: number
  todayCount: number
  estSecondsSaved: number
  streakDays: number
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export type DiagName = 'mic' | 'hotkey' | 'whisper' | 'claude' | 'paste'

export interface DiagResult {
  name: DiagName
  ok: boolean
  detail: string
  ms?: number
}

// ── IPC channel names ─────────────────────────────────────────────────────────

export const IPC = {
  DICTATION_STATE: 'dictation:state',
  DICTATION_AUDIO: 'dictation:audio',
  OVERLAY_READY: 'overlay:ready',
  HISTORY_LIST: 'history:list',
  HISTORY_SEARCH: 'history:search',
  HISTORY_DELETE: 'history:delete',
  HISTORY_STATS: 'history:stats',
  HISTORY_POLISH: 'history:polish',
  HISTORY_EDIT: 'history:edit',
  HISTORY_REINSERT: 'history:reinsert',
  HISTORY_RETRY: 'history:retry',
  HISTORY_COPY: 'history:copy',
  HISTORY_AUDIO: 'history:audio',
  DICT_LIST: 'dict:list',
  DICT_ADD: 'dict:add',
  DICT_UPDATE: 'dict:update',
  DICT_DELETE: 'dict:delete',
  DICT_UNDO_LEARN: 'dict:undoLearn',
  DICT_EXPORT: 'dict:export',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_CHANGED: 'settings:changed',
  SECRETS_GET_MASKED: 'secrets:getMasked',
  SECRETS_SET: 'secrets:set',
  DIAG_RUN: 'diag:run',
  OPEN_DASHBOARD: 'app:openDashboard'
} as const

export interface ListOpts {
  limit: number
  offset: number
}

export interface MaskedSecrets {
  whisperApiKey: string // masked, e.g. "sk-whi…1a2b"
  claudeApiKey: string
  syncToken: string
}

// ── The contract exposed on `window.api` via the preload bridge ───────────────

export interface EchoApi {
  /** The host OS, so the renderer can show platform-correct options (trigger keys, etc.). */
  platform: OSPlatform
  onDictationState(cb: (e: DictationStateEvent) => void): () => void
  onSettingsChanged(cb: (s: Settings) => void): () => void
  sendAudio(buf: ArrayBuffer, meta: AudioMeta): Promise<InsertResult>
  overlayReady(): void
  history: {
    list(opts: ListOpts): Promise<Transcript[]>
    search(q: string, opts: ListOpts): Promise<Transcript[]>
    delete(id: number): Promise<void>
    stats(): Promise<Stats>
    polish(id: number): Promise<Transcript>
    edit(id: number, text: string): Promise<EditResult>
    reinsert(id: number): Promise<InsertResult>
    retry(id: number): Promise<Transcript>
    copy(id: number): Promise<void>
    getAudio(id: number): Promise<ArrayBuffer | null>
  }
  dictionary: {
    list(): Promise<DictionaryEntry[]>
    add(word: string, misheard: string[]): Promise<DictionaryEntry>
    update(id: number, patch: { word?: string; misheard?: string[] }): Promise<DictionaryEntry | null>
    remove(id: number): Promise<void>
    undoLearn(items: LearnedCorrection[]): Promise<void>
    /** Write a portable JSON snapshot via a save dialog; returns the path, or null if cancelled. */
    export(): Promise<string | null>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    getSecretsMasked(): Promise<MaskedSecrets>
    setSecrets(patch: Partial<Secrets>): Promise<void>
  }
  diag: {
    run(name: DiagName): Promise<DiagResult>
  }
}
