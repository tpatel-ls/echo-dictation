import { describe, expect, it } from 'vitest'
import { previewFrames, previewTail } from '@shared/live-preview'

function frames(count: number, size: number): Float32Array[] {
  return Array.from({ length: count }, (_, index) => new Float32Array(size).fill(index))
}

describe('previewFrames', () => {
  it('waits until enough speech exists to be worth a decode', () => {
    expect(previewFrames(frames(10, 128), 48_000, { minMs: 500, maxMs: 20_000 })).toBeNull()
  })

  it('sends the whole utterance while it is shorter than the window', () => {
    const input = frames(200, 128)
    expect(previewFrames(input, 48_000, { minMs: 500, maxMs: 20_000 })).toHaveLength(200)
  })

  it('keeps only the most recent window of long dictations', () => {
    const input = frames(1_000, 480) // 10 s at 48 kHz
    const recent = previewFrames(input, 48_000, { minMs: 500, maxMs: 2_000 })
    expect(recent).toHaveLength(200)
    expect(recent?.[0]?.[0]).toBe(800)
    expect(recent?.at(-1)?.[0]).toBe(999)
  })
})

describe('previewTail', () => {
  it('collapses whitespace and keeps short text intact', () => {
    expect(previewTail('  hello\n  world ', 40)).toBe('hello world')
  })

  it('shows the newest words and trims on a word boundary', () => {
    expect(previewTail('we should ship the parakeet model today', 20)).toBe('…parakeet model today')
  })

  it('returns an empty string for silence', () => {
    expect(previewTail('   ', 20)).toBe('')
  })
})
