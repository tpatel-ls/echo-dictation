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
export type TriggerKey = 'RightControl' | 'LeftControl' | 'CapsLock' | 'F8'

export interface Settings {
  triggerKey: TriggerKey
  minHoldMs: number
  cancelOnOtherKey: boolean
  whisperBaseUrl: string
  whisperModel: string
  cleanupMode: CleanupMode
  claudeBaseUrl: string
  claudeModel: string
  launchAtLogin: boolean
  micMode: MicMode
  retainAudio: boolean
  insertMode: 'paste'
  overlayOffsetBottom: number
}

export const DEFAULT_SETTINGS: Settings = {
  triggerKey: 'RightControl',
  minHoldMs: 200,
  cancelOnOtherKey: true,
  // Point these at your own endpoints in Settings (any OpenAI-compatible
  // /audio/transcriptions server; any Anthropic-compatible /v1/messages proxy).
  whisperBaseUrl: '',
  whisperModel: 'whisper-1',
  cleanupMode: 'on-demand',
  claudeBaseUrl: '',
  claudeModel: 'claude-sonnet-4-6',
  launchAtLogin: true,
  micMode: 'on-demand',
  retainAudio: false,
  insertMode: 'paste',
  overlayOffsetBottom: 28
}

export interface Secrets {
  whisperApiKey: string
  claudeApiKey: string
}

export const EMPTY_SECRETS: Secrets = {
  whisperApiKey: '',
  claudeApiKey: ''
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
  HISTORY_COPY: 'history:copy',
  HISTORY_AUDIO: 'history:audio',
  DICT_LIST: 'dict:list',
  DICT_ADD: 'dict:add',
  DICT_UPDATE: 'dict:update',
  DICT_DELETE: 'dict:delete',
  DICT_UNDO_LEARN: 'dict:undoLearn',
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
}

// ── The contract exposed on `window.api` via the preload bridge ───────────────

export interface EchoApi {
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
    copy(id: number): Promise<void>
    getAudio(id: number): Promise<ArrayBuffer | null>
  }
  dictionary: {
    list(): Promise<DictionaryEntry[]>
    add(word: string, misheard: string[]): Promise<DictionaryEntry>
    update(id: number, patch: { word?: string; misheard?: string[] }): Promise<DictionaryEntry | null>
    remove(id: number): Promise<void>
    undoLearn(items: LearnedCorrection[]): Promise<void>
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
