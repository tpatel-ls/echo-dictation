import { describe, it, expect } from 'vitest'
import { encodeWav, floatToWav, resampleLinear } from '@shared/wav'

function readStr(view: DataView, off: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i))
  return s
}

describe('floatToWav', () => {
  it('writes a valid 44-byte WAV header for mono 16-bit', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
    const buf = floatToWav(samples, 16000)
    const view = new DataView(buf)
    expect(readStr(view, 0, 4)).toBe('RIFF')
    expect(readStr(view, 8, 4)).toBe('WAVE')
    expect(readStr(view, 12, 4)).toBe('fmt ')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
    expect(readStr(view, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(samples.length * 2)
    expect(buf.byteLength).toBe(44 + samples.length * 2)
  })

  it('clamps samples beyond [-1, 1]', () => {
    const buf = floatToWav(new Float32Array([2, -2]), 16000)
    const view = new DataView(buf)
    expect(view.getInt16(44, true)).toBe(0x7fff)
    expect(view.getInt16(46, true)).toBe(-0x8000)
  })
})

describe('resampleLinear', () => {
  it('returns input unchanged when rates match', () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    expect(resampleLinear(input, 16000, 16000)).toBe(input)
  })

  it('downsamples 48k → 16k to ~1/3 length', () => {
    const input = new Float32Array(300).fill(0.5)
    const out = resampleLinear(input, 48000, 16000)
    expect(out.length).toBe(100)
    expect(out[50]).toBeCloseTo(0.5, 5)
  })
})

describe('encodeWav', () => {
  it('produces a 16kHz mono WAV regardless of input rate', () => {
    const frame = new Float32Array(4800).fill(0.25) // 0.1s @ 48k
    const buf = encodeWav([frame], 48000)
    const view = new DataView(buf)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(40, true)).toBe(1600 * 2) // ~1600 samples
  })

  it('concatenates multiple frames before encoding', () => {
    const a = new Float32Array(1600).fill(0.1)
    const b = new Float32Array(1600).fill(0.2)
    const buf = encodeWav([a, b], 16000)
    const view = new DataView(buf)
    expect(view.getUint32(40, true)).toBe(3200 * 2)
  })
})
