// ─────────────────────────────────────────────────────────────────────────────
// Meeting notes — the shared contracts between the Windows meeting helper, the main-process
// pipeline, the GB10 speech routes, the stores, and the dashboard. Design:
// docs/superpowers/specs/2026-09-22-meeting-notes-design.md
// ─────────────────────────────────────────────────────────────────────────────

/** Both recorded channels are 16 kHz mono signed 16-bit little-endian PCM. */
export const MEETING_SAMPLE_RATE = 16_000

// ── Windows meeting helper (EchoMeetingHelper.exe, JSON lines over stdio) ─────

/** A process currently capturing from a microphone (an ACTIVE capture-endpoint audio session). */
export interface MicSession {
  /** Process that owns the capture session, e.g. Chrome's audio-service utility process. */
  pid: number
  /** Root of the app's process tree: the topmost ancestor with the same image name. */
  appPid: number
  /** Lower-case image file name of `appPid`, e.g. 'chrome.exe', 'ms-teams.exe', 'slack.exe'. */
  exe: string
  /** Full image path of `appPid`. */
  path: string
  /** MSIX package family name (e.g. 'MSTeams_8wekyb3d8bbwe'), or null for unpackaged apps. */
  packageFamily: string | null
  /** Capture endpoint the session lives on — the microphone the meeting app is using. */
  endpointId: string
  endpointName: string
}

/** A visible top-level window belonging to one of the probed apps. */
export interface HelperWindow {
  pid: number
  appPid: number
  exe: string
  title: string
  className: string
  minimized: boolean
}

/** A browser tab's UI Automation name, e.g. 'Meet - abc-defg-hij - Microphone recording'. */
export interface HelperBrowserTab {
  appPid: number
  exe: string
  name: string
}

/** A render (playback) audio session belonging to one of the probed apps. */
export interface RenderSession {
  pid: number
  appPid: number
  exe: string
  endpointId: string
  active: boolean
  /** Highest meter peak (0..1) sampled over ~100 ms during the probe. Reading it captures no audio. */
  peak: number
}

export interface ProbeResult {
  windows: HelperWindow[]
  tabs: HelperBrowserTab[]
  render: RenderSession[]
}

export interface RecordStartRequest {
  id: string
  /** Directory the helper writes `mic.pcm` and `others.pcm` into (created by the caller). */
  dir: string
  /** PIDs whose audio (process loopback, including direct children) is the "others" channel. */
  otherPids: number[]
  /** Capture endpoint for the "mic" channel; null uses the default communications microphone. */
  micEndpointId: string | null
}

export interface RecordStarted {
  id: string
  /** Epoch ms of sample 0 in both files. */
  startedAt: number
  /** 'process' = loopback of `otherPids`; 'system' = fallback loopback of everything except Echo. */
  othersMode: 'process' | 'system'
  micName: string
}

export interface RecordLevels {
  id: string
  /** RMS (0..1) of the last ~500 ms per channel. */
  mic: number
  others: number
  /** Samples written to each file so far (both files always have the same length). */
  samples: number
}

export type RecordWarningCode = 'mic-lost' | 'mic-reopened' | 'others-lost' | 'others-retargeted' | 'gap'

export interface RecordWarning {
  id: string
  code: RecordWarningCode
  message: string
}

export interface RecordStopped {
  id: string
  samples: number
}

/**
 * The mic channel was paused or resumed. While paused the helper writes digital silence to
 * mic.pcm in place of the microphone (the real audio never reaches disk); the timeline and both
 * files' lengths are unaffected.
 */
export interface RecordMicPaused {
  id: string
  paused: boolean
  /** Sample index in mic.pcm from which the new state applies. */
  samples: number
}

/** Helper → main. One JSON object per stdout line. */
export type HelperLine =
  | { type: 'ready'; version: number; processLoopback: boolean }
  | { type: 'mic-sessions'; sessions: MicSession[] }
  | ({ type: 'probe-result'; id: string } & ProbeResult)
  | ({ type: 'record-started' } & RecordStarted)
  | ({ type: 'record-levels' } & RecordLevels)
  | ({ type: 'record-warning' } & RecordWarning)
  | ({ type: 'record-stopped' } & RecordStopped)
  | ({ type: 'record-mic-paused' } & RecordMicPaused)
  | { type: 'error'; id?: string; code: string; message: string }
  | { type: 'log'; message: string }

/** Main → helper. One JSON object per stdin line. */
export type HelperRequest =
  | { type: 'probe'; id: string; exes: string[] }
  | ({ type: 'record-start' } & RecordStartRequest)
  | { type: 'record-retarget'; id: string; otherPids: number[] }
  | { type: 'record-stop'; id: string }
  | { type: 'record-mic-pause'; id: string; paused: boolean }
  | { type: 'shutdown' }

/** The main process's view of the helper (implemented by src/main/meetings/helper-client.ts). */
export interface MeetingHelper {
  /** Spawn (and supervise) the helper. No-op off Windows or when the binary is missing. */
  start(): void
  stop(): void
  /** True once the helper reported `ready`. */
  readonly available: boolean
  /** Latest mic-session snapshot; fires on every change (and once after `ready`). */
  onMicSessions(cb: (sessions: MicSession[]) => void): () => void
  probe(exes: string[]): Promise<ProbeResult>
  startRecording(req: RecordStartRequest): Promise<RecordStarted>
  retarget(id: string, otherPids: number[]): void
  stopRecording(id: string): Promise<RecordStopped>
  /** Pause (write silence) or resume the mic channel of the recording `id`. */
  setMicPaused(id: string, paused: boolean): Promise<RecordMicPaused>
  onLevels(cb: (levels: RecordLevels) => void): () => void
  onWarning(cb: (warning: RecordWarning) => void): () => void
}

// ── Detection ─────────────────────────────────────────────────────────────────

export type MeetingAppId = 'google-meet' | 'teams' | 'slack' | 'zoom' | 'webex'

export const MEETING_APP_IDS: readonly MeetingAppId[] = ['google-meet', 'teams', 'slack', 'zoom', 'webex']

export const MEETING_APP_LABELS: Record<MeetingAppId, string> = {
  'google-meet': 'Google Meet',
  teams: 'Microsoft Teams',
  slack: 'Slack huddle',
  zoom: 'Zoom',
  webex: 'Webex'
}

export type MeetingAppToggles = Record<MeetingAppId, boolean>

/** One meeting the detector believes is (or is about to be) in progress. */
export interface MeetingCandidate {
  /** Stable identity for this meeting instance, e.g. 'google-meet:1234:abc-defg-hij'. */
  key: string
  app: MeetingAppId
  /** True when the meeting runs in a browser tab (Meet, Teams/Slack/Zoom on the web). */
  viaBrowser: boolean
  /** Meeting title or code from the window/tab title, e.g. 'abc-defg-hij' or 'Weekly sync'. */
  title: string | null
  appPid: number
  exe: string
  /** Microphone the meeting app captures from (its capture session's endpoint). */
  micEndpointId: string | null
  /** PIDs to process-loopback for the "others" channel. */
  otherPids: number[]
  /** A render session of this app peaked above the audibility threshold in this probe. */
  remoteAudio: boolean
  /** Participant names visible in window titles, e.g. 'Meeting with Blake Whitmore'. */
  nameHints: string[]
}

export type MeetingStopReason = 'ended' | 'user' | 'discard' | 'max-duration' | 'disabled'

export type MeetingSessionAction =
  | { type: 'start'; candidate: MeetingCandidate }
  | { type: 'retarget'; otherPids: number[] }
  | { type: 'update'; candidate: MeetingCandidate }
  | { type: 'stop'; reason: MeetingStopReason }

// ── GB10 speech routes ────────────────────────────────────────────────────────

/** Exclusive (non-overlapping) diarization turn, in seconds from the start of the uploaded audio. */
export interface DiarizedTurn {
  start: number
  end: number
  speaker: string
}

export interface DiarizedSpeaker {
  /** Label local to one diarization response, e.g. 'SPEAKER_00'. */
  id: string
  speechSeconds: number
  turns: number
  /** Unit-length centroid, or null under ~3 s of speech. Never sent anywhere else. */
  embedding: number[] | null
}

export interface DiarizationResult {
  duration: number
  model: string
  embeddingModel: string
  embeddingDim: number
  segments: DiarizedTurn[]
  speakers: DiarizedSpeaker[]
}

/** A speaker-homogeneous clip to decode, in seconds from the start of the uploaded audio. */
export interface AsrSegment {
  id: string
  start: number
  end: number
  speaker: string
}

export interface SegmentTranscript {
  id: string
  /** Text per model name; a model that failed on this segment is absent. */
  texts: Record<string, string>
}

// ── Transcript, speakers, notes ───────────────────────────────────────────────

export type MeetingChannel = 'mic' | 'others'

/**
 * Speaker keys: 'me' is the local user (the mic channel's main voice). Diarized speakers are
 * '<channel>:<label>' (e.g. 'others:SPEAKER_01'). 'others' is the undiarized remote channel used by
 * the live transcript.
 */
export type SpeakerKey = string

export const SELF_SPEAKER_KEY = 'me'
export const OTHERS_SPEAKER_KEY = 'others'

export interface MeetingUtterance {
  /** ms from the start of the recording. */
  start: number
  end: number
  channel: MeetingChannel
  speakerKey: SpeakerKey
  text: string
}

/** How a speaker's display name was decided. */
export type SpeakerNameSource =
  | 'self' // the local user
  | 'voiceprint' // matched a remembered voice above the accept threshold
  | 'hint' // single remote speaker + a name in the meeting window title
  | 'user' // the user named or confirmed this speaker
  | 'calendar' // the only other attendee of the matching calendar event, or named in the conversation as one
  | 'unknown' // shown as "Speaker N"

export interface MeetingSpeaker {
  key: SpeakerKey
  /** Display name: a person's name, the user's name, or 'Speaker 2'. */
  label: string
  source: SpeakerNameSource
  personId: number | null
  /** A likely name the user can confirm with one click (voiceprint suggest band or a title hint). */
  suggestion: string | null
  /** Voiceprint cosine score of the chosen/suggested person, when one exists. */
  score: number | null
  /** Seconds of speech attributed to this speaker. */
  seconds: number
}

export type NoteVerification = 'supported' | 'insufficient' | 'unverified'

export interface NoteItem {
  text: string
  /** Action items only: who owns it and when it is due, when stated. */
  owner?: string | null
  due?: string | null
  /** Utterance ids ('u12') the item is drawn from. */
  cites: string[]
  verification: NoteVerification
  /** JEV's probability for its verdict, when verified. */
  confidence?: number
}

export interface MeetingNotes {
  summary: string[]
  decisions: NoteItem[]
  actionItems: NoteItem[]
  openQuestions: NoteItem[]
  /** Model that drafted the notes. */
  model: string
  /** Model that checked the citations (e.g. 'jev-1.13.0'), or null when not verified. */
  verifiedBy: string | null
}

// ── Stored meetings ───────────────────────────────────────────────────────────

export type MeetingStatus = 'recording' | 'processing' | 'ready' | 'failed'

export interface MeetingRecord {
  id: number
  uuid: string
  started_at: number
  ended_at: number | null
  app: MeetingAppId
  title: string | null
  status: MeetingStatus
  /** userData/meetings/<uuid>; null once the audio has been pruned. */
  audio_dir: string | null
  speakers: MeetingSpeaker[]
  notes: MeetingNotes | null
  name_hints: string[]
  /** Human-readable pipeline step while processing ('Separating speakers…'), else null. */
  progress: string | null
  error: string | null
  /** Where the .md copy was saved, once written. */
  output_path: string | null
  /** Who the calendar says attended (other than the user), when a calendar event matched. */
  participants: MeetingParticipant[]
}

/** An attendee of the meeting's calendar event. */
export interface MeetingParticipant {
  name: string
  email: string | null
}

export interface MeetingSegment {
  id: number
  meeting_id: number
  idx: number
  start_ms: number
  end_ms: number
  channel: MeetingChannel
  speaker_key: SpeakerKey
  text: string
  pass: 'live' | 'final'
}

// ── Dashboard API (window.api.meetings) ───────────────────────────────────────

export interface MeetingSummary {
  id: number
  started_at: number
  ended_at: number | null
  app: MeetingAppId
  title: string | null
  status: MeetingStatus
  progress: string | null
  /** Display names in speaking-time order. */
  speakers: string[]
}

export interface MeetingDetail extends MeetingRecord {
  segments: MeetingSegment[]
}

/**
 * What the pill shows: a meeting that is waiting to start ('detected'), one being recorded, or the
 * one that just ended (briefly, 'saved' or 'discarded').
 */
export type LiveMeetingPhase = 'idle' | 'detected' | 'recording' | 'ended'

export interface LiveMeetingState {
  phase: LiveMeetingPhase
  /** How the last recording ended, while `phase` is 'ended'; else null. */
  ended: 'saved' | 'discarded' | null
  recording: boolean
  meetingId: number | null
  app: MeetingAppId | null
  title: string | null
  startedAt: number | null
  /** Latest channel RMS levels (0..1). */
  mic: number
  others: number
  /** The mic channel records silence: paused by the user, or while the meeting app released the mic. */
  micPaused: boolean
}

/** A short message the overlay capsule shows after the fact (the meeting itself is over). */
export type MeetingNoticeKind = 'notes-ready' | 'notes-failed' | 'record-failed'

export type MeetingEvent =
  | { type: 'live'; state: LiveMeetingState }
  | { type: 'segment'; meetingId: number; segment: MeetingSegment }
  | { type: 'updated'; meetingId: number }
  /** Main asks the dashboard to open the Meetings page (and select a meeting when given). */
  | { type: 'navigate'; meetingId: number | null }
  | { type: 'notice'; kind: MeetingNoticeKind; meetingId: number }

export interface Person {
  id: number
  name: string
  exemplars: number
  /** Total seconds of speech enrolled. */
  seconds: number
}

export interface MeetingsApi {
  list(): Promise<MeetingSummary[]>
  get(id: number): Promise<MeetingDetail | null>
  live(): Promise<LiveMeetingState>
  /** Stop the current recording and process it. */
  stop(): Promise<void>
  /** Stop the current recording and delete it without processing. */
  discard(): Promise<void>
  /** Record the detected (waiting) meeting now, without waiting for the call to begin. */
  startNow(): Promise<void>
  /** Read the saved calendar address now; resolves to how many events it has today. */
  testCalendar(): Promise<number>
  /** Pause (record silence) or resume the user's mic in the current recording. */
  setMicPaused(paused: boolean): Promise<void>
  remove(id: number): Promise<void>
  /** Name a speaker; `remember` stores their voice so future meetings recognise them. */
  renameSpeaker(id: number, speakerKey: SpeakerKey, name: string, remember: boolean): Promise<MeetingDetail | null>
  /** Re-run the final pass (transcript, speakers, notes) from the retained audio. */
  reprocess(id: number): Promise<void>
  /** Save a copy through a save dialog; returns the path, or null if cancelled. */
  exportFile(id: number, format: 'md' | 'txt'): Promise<string | null>
  openFolder(id: number): Promise<void>
  people(): Promise<Person[]>
  forgetPerson(personId: number): Promise<void>
  /** Show the dashboard on the Meetings page, selecting `id` when given (used by the pill). */
  show(id: number | null): Promise<void>
  onEvent(cb: (e: MeetingEvent) => void): () => void
}

/** IPC channels behind `window.api.meetings`; MEETINGS_EVENT is main → renderer. */
export const MEETINGS_IPC = {
  LIST: 'meetings:list',
  GET: 'meetings:get',
  LIVE: 'meetings:live',
  STOP: 'meetings:stop',
  DISCARD: 'meetings:discard',
  START_NOW: 'meetings:startNow',
  TEST_CALENDAR: 'meetings:testCalendar',
  SET_MIC_PAUSED: 'meetings:setMicPaused',
  REMOVE: 'meetings:remove',
  RENAME_SPEAKER: 'meetings:renameSpeaker',
  REPROCESS: 'meetings:reprocess',
  EXPORT: 'meetings:export',
  OPEN_FOLDER: 'meetings:openFolder',
  PEOPLE: 'meetings:people',
  FORGET_PERSON: 'meetings:forgetPerson',
  SHOW: 'meetings:show',
  EVENT: 'meetings:event'
} as const

// ── Settings (merged into the app's Settings) ─────────────────────────────────

export type MeetingMode = 'auto' | 'off'

export interface MeetingSettings {
  /** 'auto' records detected meetings; 'off' never records. */
  meetingMode: MeetingMode
  meetingApps: MeetingAppToggles
  /** How the local user is labelled in transcripts; empty uses the OS account name. */
  meetingUserName: string
  /** Folder that receives the .md copy; empty uses Documents\Echo Meetings. */
  meetingOutputDir: string
  /** Days to keep meeting audio after notes are ready; 0 deletes it right away. */
  meetingRetainAudioDays: number
  /** Fast model for the live transcript. */
  meetingLiveModel: string
  /** Most accurate model for the final pass. */
  meetingFinalModel: string
  /** Cross-check model for the final pass (hallucination guard). */
  meetingCheckModel: string
  /**
   * Keyword-biased model decoded alongside the final pass; only its spelling of listed names and
   * terms is borrowed, one word for one word (vocab-transplant.ts). Empty turns it off.
   */
  meetingVocabModel: string
  /** Draft summary, decisions, and action items with the AI proxy. */
  meetingNotes: boolean
  /** Check each note against the transcript with TypeSafe JEV (needs a TypeSafe key). */
  meetingVerifyNotes: boolean
  /** Also announce meeting states with Windows notifications (the overlay always shows them). */
  meetingNotifications: boolean
  /** The user's own calendar email, so they are left out of a meeting's calendar attendees. */
  meetingMyEmail: string
}

export const DEFAULT_MEETING_SETTINGS: MeetingSettings = {
  meetingMode: 'auto',
  meetingApps: { 'google-meet': true, teams: true, slack: true, zoom: true, webex: true },
  meetingUserName: '',
  meetingOutputDir: '',
  meetingRetainAudioDays: 30,
  meetingLiveModel: 'parakeet-tdt-0.6b-v2',
  meetingFinalModel: 'canary-qwen-2.5b',
  meetingCheckModel: 'parakeet-tdt-0.6b-v2',
  meetingVocabModel: 'granite-speech-4.1-2b',
  meetingNotes: true,
  meetingVerifyNotes: true,
  meetingNotifications: false,
  meetingMyEmail: ''
}
