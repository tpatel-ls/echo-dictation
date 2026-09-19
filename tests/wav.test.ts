import { describe, it, expect } from 'vitest'
import { encodeWav, floatToWav, isSilentWav, resampleLinear } from '@shared/wav'

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

  it('filters frequencies above the 16kHz Nyquist limit instead of aliasing them into speech', () => {
    const inputRate = 48000
    const frequency = 12000
    const input = Float32Array.from(
      { length: inputRate / 5 },
      (_, index) => Math.sin((2 * Math.PI * frequency * index) / inputRate)
    )

    const out = resampleLinear(input, inputRate, 16000)
    const middle = out.subarray(32, out.length - 32)
    const rms = Math.sqrt(middle.reduce((sum, sample) => sum + sample * sample, 0) / middle.length)

    expect(rms).toBeLessThan(0.08)
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

describe('isSilentWav', () => {
  it('flags a take from a dead input stream, which is all digital zeros', () => {
    expect(isSilentWav(encodeWav([new Float32Array(4800)], 48000))).toBe(true)
  })

  it('flags a take that captured no frames at all', () => {
    expect(isSilentWav(encodeWav([], 48000))).toBe(true)
  })

  it('passes a quiet room, whose noise floor still moves the samples', () => {
    // A -68 dBFS hum, around the floor of a USB mic in a quiet room.
    const hum = Float32Array.from({ length: 4800 }, (_, index) => 0.0004 * Math.sin((2 * Math.PI * 200 * index) / 48000))
    expect(isSilentWav(encodeWav([hum], 48000))).toBe(false)
  })

  it('passes a take with a single non-zero sample', () => {
    const samples = new Float32Array(1600)
    samples[900] = 0.01
    expect(isSilentWav(floatToWav(samples, 16000))).toBe(false)
  })

  it('finds the data chunk behind other chunks', () => {
    const wav = new Uint8Array(floatToWav(new Float32Array([0, 0.5]), 16000))
    const list = new Uint8Array([...'LIST'].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0, 1, 2, 3, 4]))
    const withList = new Uint8Array(wav.length + list.length)
    withList.set(wav.subarray(0, 36))
    withList.set(list, 36)
    withList.set(wav.subarray(36), 36 + list.length)
    expect(isSilentWav(withList.buffer)).toBe(false)
  })

  it('never blocks audio it cannot parse', () => {
    expect(isSilentWav(new ArrayBuffer(0))).toBe(false)
    expect(isSilentWav(new Uint8Array(64).buffer)).toBe(false)
  })
})
