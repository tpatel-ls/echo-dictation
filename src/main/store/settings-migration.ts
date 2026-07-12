import {
  DEFAULT_SETTINGS,
  type AccuracyMode,
  type CleanupMode,
  type MicMode,
  type Settings,
  type TriggerKey
} from '@shared/types'

const TRIGGER_KEYS = new Set<TriggerKey>([
  'RightControl', 'LeftControl', 'RightCommand', 'LeftCommand', 'EitherOption',
  'LeftOption', 'RightOption', 'CapsLock', 'F8'
])
const CLEANUP_MODES = new Set<CleanupMode>(['off', 'auto', 'on-demand'])
const ACCURACY_MODES = new Set<AccuracyMode>(['fast', 'balanced', 'maximum'])
const MIC_MODES = new Set<MicMode>(['on-demand', 'warm'])

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

export function normalizeSettings(
  input: unknown,
  defaults: Settings = DEFAULT_SETTINGS
): Settings {
  const value = record(input)
  return {
    triggerKey: triggerKey(value.triggerKey, defaults.triggerKey),
    minHoldMs: boundedInteger(value.minHoldMs, defaults.minHoldMs, 50, 5_000),
    cancelOnOtherKey: booleanValue(value.cancelOnOtherKey, defaults.cancelOnOtherKey),
    whisperBaseUrl: stringValue(value.whisperBaseUrl, defaults.whisperBaseUrl),
    whisperModel: stringValue(value.whisperModel, defaults.whisperModel),
    cleanupMode: cleanupMode(value.cleanupMode, defaults.cleanupMode),
    accuracyMode: ACCURACY_MODES.has(value.accuracyMode as AccuracyMode)
      ? value.accuracyMode as AccuracyMode
      : defaults.accuracyMode,
    claudeBaseUrl: stringValue(value.claudeBaseUrl, defaults.claudeBaseUrl),
    claudeModel: stringValue(value.claudeModel, defaults.claudeModel),
    accuracyModel: stringValue(value.accuracyModel, defaults.accuracyModel),
    commandModeEnabled: booleanValue(value.commandModeEnabled, defaults.commandModeEnabled),
    launchAtLogin: booleanValue(value.launchAtLogin, defaults.launchAtLogin),
    micMode: MIC_MODES.has(value.micMode as MicMode) ? value.micMode as MicMode : defaults.micMode,
    audioInputDeviceId: stringValue(value.audioInputDeviceId, defaults.audioInputDeviceId),
    retainAudio: booleanValue(value.retainAudio, defaults.retainAudio),
    insertMode: 'paste',
    overlayOffsetBottom: boundedInteger(
      value.overlayOffsetBottom,
      defaults.overlayOffsetBottom,
      0,
      300
    ),
    syncBaseUrl: stringValue(value.syncBaseUrl, defaults.syncBaseUrl)
  }
}
