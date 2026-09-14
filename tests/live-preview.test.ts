import { describe, expect, it } from 'vitest'
import { PreviewAudio } from '@shared/live-preview'

function feed(preview: PreviewAudio, seconds: number, rate = 48_000, value = 0.25): void {
  const frame = new Float32Array(128).fill(value)
  const frames = Math.round((seconds * rate) / 128)
  for (let i = 0; i < frames; i++) preview.push(frame, rate)
}

function dataBytes(wav: ArrayBuffer | null): number {
  return wav ? new DataView(wav).getUint32(40, true) : -1
}

describe('PreviewAudio', () => {
  it('waits until enough speech exists to be worth a decode', () => {
    const preview = new PreviewAudio({ minMs: 600, maxMs: 20_000 })
    feed(preview, 0.5)
    expect(preview.wav()).toBeNull()
  })

  it('downsamples incrementally to 16 kHz without distorting the level', () => {
    const preview = new PreviewAudio({ minMs: 600, maxMs: 20_000 })
    feed(preview, 1)
    const wav = preview.wav()
    expect(new DataView(wav!).getUint32(24, true)).toBe(16_000)
    expect(dataBytes(wav)).toBe(16_000 * 2)
    expect(new DataView(wav!).getInt16(44 + 200, true)).toBe(Math.trunc(0.25 * 0x7fff))
  })

  it('keeps only the most recent window of long dictations', () => {
    const preview = new PreviewAudio({ minMs: 600, maxMs: 2_000 })
    feed(preview, 5)
    expect(dataBytes(preview.wav())).toBe(2 * 16_000 * 2)
  })

  it('handles non-integer device rates and resets between dictations', () => {
    const preview = new PreviewAudio({ minMs: 600, maxMs: 20_000 })
    feed(preview, 1, 44_100)
    expect(Math.abs(dataBytes(preview.wav()) - 32_000)).toBeLessThanOrEqual(200)
    preview.reset()
    expect(preview.wav()).toBeNull()
  })
})
