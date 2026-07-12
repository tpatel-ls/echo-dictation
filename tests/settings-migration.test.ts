import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { normalizeSettings } from '../src/main/store/settings-migration'

describe('normalizeSettings', () => {
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
