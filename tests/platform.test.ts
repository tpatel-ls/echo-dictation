import { describe, it, expect } from 'vitest'
import { pasteModifier } from '../src/main/insert/platform'
import { defaultTriggerKey, triggerLabel, triggerOptions } from '@shared/trigger'

describe('pasteModifier', () => {
  it('uses Command (super) on macOS', () => {
    expect(pasteModifier('darwin')).toBe('super')
  })
  it('uses Control on Windows and Linux', () => {
    expect(pasteModifier('win32')).toBe('control')
    expect(pasteModifier('linux')).toBe('control')
  })
})

describe('defaultTriggerKey', () => {
  it('defaults to either Option key on macOS', () => {
    expect(defaultTriggerKey('darwin')).toBe('EitherOption')
  })
  it('defaults to Right Ctrl on Windows/Linux', () => {
    expect(defaultTriggerKey('win32')).toBe('RightControl')
    expect(defaultTriggerKey('linux')).toBe('RightControl')
  })
})

describe('triggerOptions', () => {
  it('leads with Option keys on macOS and omits Right/Left Ctrl', () => {
    const opts = triggerOptions('darwin')
    expect(opts[0]).toBe('EitherOption')
    expect(opts).toContain('LeftOption')
    expect(opts).toContain('RightOption')
    expect(opts).not.toContain('RightControl')
    expect(opts).not.toContain('LeftControl')
  })
  it('leads with Ctrl on Windows and omits the Mac-only modifiers', () => {
    const opts = triggerOptions('win32')
    expect(opts[0]).toBe('RightControl')
    expect(opts).not.toContain('RightCommand')
    expect(opts).not.toContain('RightOption')
  })
  it('only offers keys that have a label', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      for (const key of triggerOptions(platform)) {
        expect(triggerLabel(key)).toBeTruthy()
      }
    }
  })
})

describe('triggerLabel', () => {
  it('renders the Mac modifier glyphs', () => {
    expect(triggerLabel('RightCommand')).toBe('Right ⌘')
    expect(triggerLabel('EitherOption')).toBe('Left or Right ⌥')
    expect(triggerLabel('LeftOption')).toBe('Left ⌥')
    expect(triggerLabel('RightOption')).toBe('Right ⌥')
  })
  it('renders the Windows keys', () => {
    expect(triggerLabel('RightControl')).toBe('Right Ctrl')
    expect(triggerLabel('CapsLock')).toBe('Caps Lock')
  })
})
