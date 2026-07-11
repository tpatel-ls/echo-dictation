import { describe, expect, it } from 'vitest'
import { resolveAudioDevice } from '../src/renderer/overlay/audio-device'

const devices = [
  { deviceId: 'built-in', label: 'MacBook Air Microphone' },
  { deviceId: 'usb', label: 'USB Microphone' }
]

describe('resolveAudioDevice', () => {
  it('keeps an available preferred input', () => {
    expect(resolveAudioDevice('built-in', devices)).toEqual({ deviceId: 'built-in', fellBack: false })
  })

  it('falls back to the system default when the preferred input disappeared', () => {
    expect(resolveAudioDevice('missing', devices)).toEqual({ deviceId: undefined, fellBack: true })
  })

  it('uses the system default when no input was selected', () => {
    expect(resolveAudioDevice('', devices)).toEqual({ deviceId: undefined, fellBack: false })
  })
})
