import { describe, it, expect } from 'vitest'
import { HotkeyMachine } from '../src/main/hotkey/machine'

const opts = { minHoldMs: 200, cancelOnOtherKey: true }

describe('HotkeyMachine', () => {
  it('emits start on trigger-down', () => {
    const m = new HotkeyMachine(opts)
    expect(m.handle({ type: 'trigger-down', t: 0 })).toEqual({ type: 'start', t: 0 })
    expect(m.isActive).toBe(true)
  })

  it('cancels a tap shorter than minHoldMs', () => {
    const m = new HotkeyMachine(opts)
    m.handle({ type: 'trigger-down', t: 0 })
    expect(m.handle({ type: 'trigger-up', t: 100 })).toEqual({
      type: 'cancel',
      t: 100,
      reason: 'too-short'
    })
    expect(m.isActive).toBe(false)
  })

  it('stops with duration on a valid hold', () => {
    const m = new HotkeyMachine(opts)
    m.handle({ type: 'trigger-down', t: 0 })
    expect(m.handle({ type: 'trigger-up', t: 1500 })).toEqual({
      type: 'stop',
      t: 1500,
      durationMs: 1500
    })
  })

  it('ignores auto-repeat trigger-down while active', () => {
    const m = new HotkeyMachine(opts)
    m.handle({ type: 'trigger-down', t: 0 })
    expect(m.handle({ type: 'trigger-down', t: 10 })).toBeNull()
    expect(m.handle({ type: 'trigger-down', t: 20 })).toBeNull()
  })

  it('cancels on other key during hold when enabled, ignoring the later release', () => {
    const m = new HotkeyMachine(opts)
    m.handle({ type: 'trigger-down', t: 0 })
    expect(m.handle({ type: 'other-key', t: 50 })).toEqual({
      type: 'cancel',
      t: 50,
      reason: 'other-key'
    })
    expect(m.handle({ type: 'trigger-up', t: 300 })).toBeNull()
  })

  it('does not cancel on other key when disabled', () => {
    const m = new HotkeyMachine({ minHoldMs: 200, cancelOnOtherKey: false })
    m.handle({ type: 'trigger-down', t: 0 })
    expect(m.handle({ type: 'other-key', t: 50 })).toBeNull()
    expect(m.handle({ type: 'trigger-up', t: 300 })).toEqual({
      type: 'stop',
      t: 300,
      durationMs: 300
    })
  })

  it('ignores trigger-up without a prior down', () => {
    const m = new HotkeyMachine(opts)
    expect(m.handle({ type: 'trigger-up', t: 0 })).toBeNull()
  })

  it('starts a fresh dictation after a cancel', () => {
    const m = new HotkeyMachine(opts)
    m.handle({ type: 'trigger-down', t: 0 })
    m.handle({ type: 'other-key', t: 50 })
    m.handle({ type: 'trigger-up', t: 60 })
    expect(m.handle({ type: 'trigger-down', t: 1000 })).toEqual({ type: 'start', t: 1000 })
    expect(m.handle({ type: 'trigger-up', t: 1400 })).toEqual({
      type: 'stop',
      t: 1400,
      durationMs: 400
    })
  })
})
