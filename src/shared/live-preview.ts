// Live transcript preview: while the hotkey is held, the overlay periodically ships the audio captured
// so far for a best-effort decode and shows the newest words above the bar. The final decode at
// release remains the only text that is ever inserted.

import { floatToWav, mergeFrames, TARGET_RATE } from './wav'

export interface PreviewWindow {
  /** Skip the decode until at least this much audio exists. */
  minMs: number
  /** Long dictations only send the most recent audio so each preview request stays small and fast. */
  maxMs: number
}

export const PREVIEW_WINDOW: PreviewWindow = { minMs: 600, maxMs: 20_000 }
/** Pause between one preview response and the next request. */
export const PREVIEW_INTERVAL_MS = 350
/** About two lines of the transcript bubble above the recording pill. */
export const PREVIEW_MAX_CHARS = 110

/** Greedy recognizers served on the GB10 (NVIDIA Parakeet, Canary-Qwen) return the same text for every
 *  re-decode of the same audio, so temperature samples add nothing. */
export function isDeterministicModel(model: string): boolean {
  return /parakeet|canary/i.test(model)
}

/** Parakeet is fast enough to decode the utterance-so-far several times a second. */
export function supportsLivePreview(model: string): boolean {
  return /parakeet/i.test(model)
}

/**
 * 16 kHz preview audio built incrementally as mic frames arrive, so each preview request only
 * copies the window instead of re-resampling the whole utterance on the overlay's UI thread.
 * Quality is preview-grade (block average / linear); the final decode uses the full encoder.
 */
export class PreviewAudio {
  private chunks: Float32Array[] = []
  private length = 0
  private carry = new Float32Array(0)
  private phase = 0

  constructor(private window: PreviewWindow = PREVIEW_WINDOW) {}

  reset(): void {
    this.chunks = []
    this.length = 0
    this.carry = new Float32Array(0)
    this.phase = 0
  }

  push(frame: Float32Array, sampleRate: number): void {
    const ratio = sampleRate / TARGET_RATE
    const out = Number.isInteger(ratio) && ratio >= 1 ? this.average(frame, ratio) : this.interpolate(frame, ratio)
    if (!out.length) return
    this.chunks.push(out)
    this.length += out.length
    const maxSamples = (TARGET_RATE * this.window.maxMs) / 1000
    while (this.chunks.length > 1 && this.length - (this.chunks[0]?.length ?? 0) >= maxSamples) {
      this.length -= this.chunks.shift()?.length ?? 0
    }
  }

  wav(): ArrayBuffer | null {
    if (this.length < (TARGET_RATE * this.window.minMs) / 1000) return null
    const merged = mergeFrames(this.chunks)
    const maxSamples = (TARGET_RATE * this.window.maxMs) / 1000
    return floatToWav(merged.length > maxSamples ? merged.subarray(merged.length - maxSamples) : merged, TARGET_RATE)
  }

  private average(frame: Float32Array, ratio: number): Float32Array {
    let input = frame
    if (this.carry.length) {
      input = new Float32Array(this.carry.length + frame.length)
      input.set(this.carry)
      input.set(frame, this.carry.length)
    }
    const count = Math.floor(input.length / ratio)
    const out = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      let sum = 0
      for (let k = 0; k < ratio; k++) sum += input[i * ratio + k] ?? 0
      out[i] = sum / ratio
    }
    this.carry = input.slice(count * ratio)
    return out
  }

  private interpolate(frame: Float32Array, ratio: number): Float32Array {
    const out: number[] = []
    let position = this.phase
    while (position < frame.length) {
      const index = Math.floor(position)
      const a = frame[index] ?? 0
      const b = frame[index + 1] ?? a
      out.push(a + (b - a) * (position - index))
      position += ratio
    }
    this.phase = position - frame.length
    return Float32Array.from(out)
  }
}

/** The newest words of a preview, trimmed on a word boundary so the bubble never shows half a word. */
export function previewTail(text: string, maxChars: number = PREVIEW_MAX_CHARS): string {
  const t = text.trim().replace(/\s+/g, ' ')
  if (t.length <= maxChars) return t
  const start = t.length - maxChars
  const cut = t.slice(start)
  if (t[start - 1] === ' ') return `…${cut}`
  const space = cut.indexOf(' ')
  return `…${space >= 0 ? cut.slice(space + 1) : cut}`
}
