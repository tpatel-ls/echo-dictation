import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { DEFAULT_MEETING_SETTINGS } from '@shared/meeting-types'
import { defaultSettingsFor, normalizeSettings } from '../src/main/store/settings-migration'

describe('normalizeSettings', () => {
  it('defaults to the fast, polished English experience', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      cleanupMode: 'auto',
      accuracyMode: 'balanced',
      claudeModel: 'claude-sonnet-5',
      micMode: 'warm'
    })
  })

  it('enables the live preview by default and keeps an explicit opt-out', () => {
    expect(DEFAULT_SETTINGS.livePreview).toBe(true)
    expect(normalizeSettings({ livePreview: false }).livePreview).toBe(false)
    expect(normalizeSettings({ livePreview: 'no' }).livePreview).toBe(true)
  })

  it('decodes the live preview with Parakeet unless another preview model is saved', () => {
    expect(normalizeSettings({}).previewModel).toBe('parakeet-tdt-0.6b-v2')
    expect(normalizeSettings({ previewModel: 'parakeet-tdt-0.6b-v3' }).previewModel).toBe('parakeet-tdt-0.6b-v3')
  })

  it('keeps supported values and ignores unknown persisted keys', () => {
    const result = normalizeSettings({
      ...DEFAULT_SETTINGS,
      triggerKey: 'RightOption',
      minHoldMs: 350,
      unknownSetting: 'discard me'
    })

    expect(result.triggerKey).toBe('RightOption')
    expect(result.minHoldMs).toBe(350)
    expect(result).not.toHaveProperty('unknownSetting')
  })

  it('falls back when persisted values have unsafe types or unsupported enums', () => {
    const result = normalizeSettings({
      triggerKey: 'Spacebar',
      cancelOnOtherKey: 'yes',
      cleanupMode: 'always',
      micMode: null,
      whisperModel: 42,
      retainAudio: []
    })

    expect(result.triggerKey).toBe(DEFAULT_SETTINGS.triggerKey)
    expect(result.cancelOnOtherKey).toBe(DEFAULT_SETTINGS.cancelOnOtherKey)
    expect(result.cleanupMode).toBe(DEFAULT_SETTINGS.cleanupMode)
    expect(result.micMode).toBe(DEFAULT_SETTINGS.micMode)
    expect(result.whisperModel).toBe(DEFAULT_SETTINGS.whisperModel)
    expect(result.retainAudio).toBe(DEFAULT_SETTINGS.retainAudio)
  })

  it('clamps numeric controls to safe integer bounds', () => {
    expect(normalizeSettings({ minHoldMs: -20, overlayOffsetBottom: 9999 })).toMatchObject({
      minHoldMs: 50,
      overlayOffsetBottom: 300
    })
    expect(normalizeSettings({ minHoldMs: 300.8, overlayOffsetBottom: 27.6 })).toMatchObject({
      minHoldMs: 301,
      overlayOffsetBottom: 28
    })
  })

  it('migrates legacy platform key and cleanup values', () => {
    expect(normalizeSettings({ triggerKey: 'RightAlt', cleanupMode: true })).toMatchObject({
      triggerKey: 'RightOption',
      cleanupMode: 'auto'
    })
    expect(normalizeSettings({ triggerKey: 'EitherControl' }).triggerKey).toBe('EitherControl')
    expect(normalizeSettings({ triggerKey: 'LeftAlt', cleanupMode: false })).toMatchObject({
      triggerKey: 'LeftOption',
      cleanupMode: 'off'
    })
  })

  it('uses caller-provided platform defaults', () => {
    const defaults = { ...DEFAULT_SETTINGS, triggerKey: 'RightControl' as const }
    expect(normalizeSettings({ triggerKey: 'invalid' }, defaults).triggerKey).toBe('RightControl')
  })

  it('treats non-object input as an empty settings document', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(['bad'])).toEqual(DEFAULT_SETTINGS)
  })
})

describe('meeting settings', () => {
  it('ships the meeting defaults with recording off until a platform turns it on', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ ...DEFAULT_MEETING_SETTINGS, meetingMode: 'off' })
  })

  it('records meetings automatically by default on Windows only', () => {
    expect(defaultSettingsFor('win32').meetingMode).toBe('auto')
    expect(defaultSettingsFor('darwin').meetingMode).toBe('off')
    expect(defaultSettingsFor('linux').meetingMode).toBe('off')
  })

  it('keeps the platform trigger key in the platform defaults', () => {
    expect(defaultSettingsFor('win32').triggerKey).toBe('RightControl')
    expect(defaultSettingsFor('darwin').triggerKey).toBe('EitherOption')
  })

  it('keeps an explicit meeting mode and rejects unknown ones', () => {
    const windows = defaultSettingsFor('win32')
    expect(normalizeSettings({ meetingMode: 'off' }, windows).meetingMode).toBe('off')
    expect(normalizeSettings({ meetingMode: 'always' }, windows).meetingMode).toBe('auto')
    expect(normalizeSettings({}, windows).meetingMode).toBe('auto')
  })

  it('fills per-app toggles for missing apps and drops unknown ones', () => {
    const result = normalizeSettings({ meetingApps: { zoom: false, slack: 'no', skype: true } })
    expect(result.meetingApps).toEqual({
      'google-meet': true,
      teams: true,
      slack: true,
      zoom: false,
      webex: true
    })
    expect(normalizeSettings({ meetingApps: null }).meetingApps).toEqual(DEFAULT_MEETING_SETTINGS.meetingApps)
  })

  it('does not share the per-app toggles object with the defaults', () => {
    const result = normalizeSettings({})
    result.meetingApps.zoom = false
    expect(DEFAULT_SETTINGS.meetingApps.zoom).toBe(true)
  })

  it('clamps audio retention to 0-3650 whole days', () => {
    expect(normalizeSettings({ meetingRetainAudioDays: 0 }).meetingRetainAudioDays).toBe(0)
    expect(normalizeSettings({ meetingRetainAudioDays: -4 }).meetingRetainAudioDays).toBe(0)
    expect(normalizeSettings({ meetingRetainAudioDays: 99_999 }).meetingRetainAudioDays).toBe(3650)
    expect(normalizeSettings({ meetingRetainAudioDays: 7.6 }).meetingRetainAudioDays).toBe(8)
    expect(normalizeSettings({ meetingRetainAudioDays: '7' }).meetingRetainAudioDays).toBe(30)
  })

  it('keeps the user\'s calendar email, trimmed', () => {
    expect(normalizeSettings({}).meetingMyEmail).toBe('')
    expect(normalizeSettings({ meetingMyEmail: ' tanay@example.com ' }).meetingMyEmail).toBe('tanay@example.com')
    expect(normalizeSettings({ meetingMyEmail: 4 }).meetingMyEmail).toBe('')
  })

  it('shows meeting states in the overlay only, unless Windows notifications are turned on', () => {
    expect(normalizeSettings({}).meetingNotifications).toBe(false)
    expect(normalizeSettings({ meetingNotifications: true }).meetingNotifications).toBe(true)
    expect(normalizeSettings({ meetingNotifications: 'yes' }).meetingNotifications).toBe(false)
  })

  it('borrows listed terms from Granite by default; an empty vocabulary model turns it off', () => {
    expect(normalizeSettings({}).meetingVocabModel).toBe('granite-speech-4.1-2b')
    expect(DEFAULT_SETTINGS.meetingVocabModel).toBe('granite-speech-4.1-2b')
    expect(normalizeSettings({ meetingVocabModel: '' }).meetingVocabModel).toBe('')
    expect(normalizeSettings({ meetingVocabModel: '  ' }).meetingVocabModel).toBe('')
    expect(normalizeSettings({ meetingVocabModel: ' granite-speech-4.1-8b ' }).meetingVocabModel).toBe('granite-speech-4.1-8b')
    expect(normalizeSettings({ meetingVocabModel: 3 }).meetingVocabModel).toBe('granite-speech-4.1-2b')
  })

  it('keeps string and boolean meeting fields and falls back on bad types', () => {
    const saved = {
      meetingUserName: 'Tanay',
      meetingOutputDir: 'D:\\Notes',
      meetingLiveModel: 'parakeet-tdt-0.6b-v3',
      meetingFinalModel: 'canary-1b',
      meetingCheckModel: 'whisper-1',
      meetingNotes: false,
      meetingVerifyNotes: false
    }
    expect(normalizeSettings(saved)).toMatchObject(saved)
    expect(normalizeSettings({
      meetingUserName: 7,
      meetingOutputDir: null,
      meetingLiveModel: [],
      meetingFinalModel: {},
      meetingCheckModel: false,
      meetingNotes: 'yes',
      meetingVerifyNotes: 1
    })).toMatchObject({
      meetingUserName: '',
      meetingOutputDir: '',
      meetingLiveModel: 'parakeet-tdt-0.6b-v2',
      meetingFinalModel: 'canary-qwen-2.5b',
      meetingCheckModel: 'parakeet-tdt-0.6b-v2',
      meetingNotes: true,
      meetingVerifyNotes: true
    })
  })
})
