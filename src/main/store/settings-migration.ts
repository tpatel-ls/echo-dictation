import {
  DEFAULT_SETTINGS,
  type AccuracyMode,
  type CleanupMode,
  type MicMode,
  type OSPlatform,
  type Settings,
  type TriggerKey
} from '@shared/types'
import { MEETING_APP_IDS, type MeetingAppToggles, type MeetingMode } from '@shared/meeting-types'
import { defaultTriggerKey } from '@shared/trigger'
import { normalizeEndpointUrl } from './endpoint-url'

const TRIGGER_KEYS = new Set<TriggerKey>([
  'EitherControl', 'RightControl', 'LeftControl', 'RightCommand', 'LeftCommand', 'EitherOption',
  'LeftOption', 'RightOption', 'CapsLock', 'F8'
])
const CLEANUP_MODES = new Set<CleanupMode>(['off', 'auto', 'on-demand'])
const ACCURACY_MODES = new Set<AccuracyMode>(['fast', 'balanced', 'maximum'])
const MIC_MODES = new Set<MicMode>(['on-demand', 'warm'])
const MEETING_MODES = new Set<MeetingMode>(['auto', 'off'])

/**
 * Fresh-install defaults for a platform. The trigger key depends on the keyboard (macOS has no
 * Right Ctrl), and meetings record automatically only where the Windows meeting helper exists.
 */
export function defaultSettingsFor(platform: OSPlatform): Settings {
  return {
    ...DEFAULT_SETTINGS,
    meetingApps: { ...DEFAULT_SETTINGS.meetingApps },
    triggerKey: defaultTriggerKey(platform),
    meetingMode: platform === 'win32' ? 'auto' : 'off'
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function triggerKey(value: unknown, fallback: TriggerKey): TriggerKey {
  if (value === 'RightAlt') return 'RightOption'
  if (value === 'LeftAlt') return 'LeftOption'
  return TRIGGER_KEYS.has(value as TriggerKey) ? value as TriggerKey : fallback
}

function cleanupMode(value: unknown, fallback: CleanupMode): CleanupMode {
  if (value === true) return 'auto'
  if (value === false) return 'off'
  return CLEANUP_MODES.has(value as CleanupMode) ? value as CleanupMode : fallback
}

/** One boolean per known app; apps missing from the saved document keep their default. */
function meetingApps(value: unknown, fallback: MeetingAppToggles): MeetingAppToggles {
  const saved = record(value)
  const apps = {} as MeetingAppToggles
  for (const id of MEETING_APP_IDS) apps[id] = booleanValue(saved[id], fallback[id] ?? true)
  return apps
}

export function normalizeSettings(
  input: unknown,
  defaults: Settings = DEFAULT_SETTINGS
): Settings {
  const value = record(input)
  return {
    triggerKey: triggerKey(value.triggerKey, defaults.triggerKey),
    minHoldMs: boundedInteger(value.minHoldMs, defaults.minHoldMs, 50, 5_000),
    cancelOnOtherKey: booleanValue(value.cancelOnOtherKey, defaults.cancelOnOtherKey),
    whisperBaseUrl: normalizeEndpointUrl(value.whisperBaseUrl, defaults.whisperBaseUrl),
    whisperModel: stringValue(value.whisperModel, defaults.whisperModel),
    previewModel: stringValue(value.previewModel, defaults.previewModel),
    crossCheckModels: stringValue(value.crossCheckModels, defaults.crossCheckModels),
    cleanupMode: cleanupMode(value.cleanupMode, defaults.cleanupMode),
    accuracyMode: ACCURACY_MODES.has(value.accuracyMode as AccuracyMode)
      ? value.accuracyMode as AccuracyMode
      : defaults.accuracyMode,
    claudeBaseUrl: normalizeEndpointUrl(value.claudeBaseUrl, defaults.claudeBaseUrl),
    claudeModel: stringValue(value.claudeModel, defaults.claudeModel),
    accuracyModel: stringValue(value.accuracyModel, defaults.accuracyModel),
    fallbackModel: stringValue(value.fallbackModel, defaults.fallbackModel),
    adjudicatorModel: stringValue(value.adjudicatorModel, defaults.adjudicatorModel),
    commandModeEnabled: booleanValue(value.commandModeEnabled, defaults.commandModeEnabled),
    launchAtLogin: booleanValue(value.launchAtLogin, defaults.launchAtLogin),
    micMode: MIC_MODES.has(value.micMode as MicMode) ? value.micMode as MicMode : defaults.micMode,
    audioInputDeviceId: stringValue(value.audioInputDeviceId, defaults.audioInputDeviceId),
    retainAudio: booleanValue(value.retainAudio, defaults.retainAudio),
    livePreview: booleanValue(value.livePreview, defaults.livePreview),
    insertMode: 'paste',
    overlayOffsetBottom: boundedInteger(
      value.overlayOffsetBottom,
      defaults.overlayOffsetBottom,
      0,
      300
    ),
    syncBaseUrl: normalizeEndpointUrl(value.syncBaseUrl, defaults.syncBaseUrl),
    meetingMode: MEETING_MODES.has(value.meetingMode as MeetingMode)
      ? value.meetingMode as MeetingMode
      : defaults.meetingMode,
    meetingApps: meetingApps(value.meetingApps, defaults.meetingApps),
    meetingUserName: stringValue(value.meetingUserName, defaults.meetingUserName),
    meetingOutputDir: stringValue(value.meetingOutputDir, defaults.meetingOutputDir),
    meetingRetainAudioDays: boundedInteger(
      value.meetingRetainAudioDays,
      defaults.meetingRetainAudioDays,
      0,
      3650
    ),
    meetingLiveModel: stringValue(value.meetingLiveModel, defaults.meetingLiveModel),
    meetingFinalModel: stringValue(value.meetingFinalModel, defaults.meetingFinalModel),
    meetingCheckModel: stringValue(value.meetingCheckModel, defaults.meetingCheckModel),
    meetingVocabModel: stringValue(value.meetingVocabModel, defaults.meetingVocabModel).trim(),
    meetingNotes: booleanValue(value.meetingNotes, defaults.meetingNotes),
    meetingVerifyNotes: booleanValue(value.meetingVerifyNotes, defaults.meetingVerifyNotes),
    meetingNotifications: booleanValue(value.meetingNotifications, defaults.meetingNotifications),
    meetingMyEmail: stringValue(value.meetingMyEmail, defaults.meetingMyEmail).trim()
  }
}
