import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pcm16FromBytes } from '@shared/meeting-audio'

// Reads of the helper's growing 16 kHz mono s16le files (mic.pcm, others.pcm). The helper appends
// while Echo reads, so a read can end mid-sample; the odd byte is carried to the next read.

function fileSize(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

/** Follows one growing PCM file, returning only what was appended since the previous read. */
export class PcmTail {
  private offset = 0
  private carry: number | null = null

  constructor(private readonly path: string) {}

  /** Whole samples consumed so far. */
  get samplesRead(): number {
    return Math.floor(this.offset / 2)
  }

  /** New samples (at most `maxSamples`); empty while the file is missing or has not grown. */
  read(maxSamples = Number.POSITIVE_INFINITY): Int16Array {
    const size = fileSize(this.path)
    if (size === null || size <= this.offset) return new Int16Array(0)
    const available = size - this.offset
    const want = Math.min(available, Number.isFinite(maxSamples) ? maxSamples * 2 - (this.carry === null ? 0 : 1) : available)
    if (want <= 0) return new Int16Array(0)
    const buf = Buffer.alloc(want)
    let fd: number | null = null
    let got = 0
    try {
      fd = openSync(this.path, 'r')
      while (got < want) {
        const n = readSync(fd, buf, got, want - got, this.offset + got)
        if (n <= 0) break
        got += n
      }
    } catch {
      return new Int16Array(0)
    } finally {
      if (fd !== null) closeSync(fd)
    }
    this.offset += got
    const joined = this.carry === null ? buf.subarray(0, got) : Buffer.concat([Buffer.from([this.carry]), buf.subarray(0, got)])
    this.carry = joined.length % 2 === 1 ? joined[joined.length - 1] : null
    return pcm16FromBytes(joined.length % 2 === 1 ? joined.subarray(0, joined.length - 1) : joined)
  }
}

/** A whole PCM file as samples; a missing file is empty. */
export function readPcmFile(path: string): Int16Array {
  try {
    return pcm16FromBytes(readFileSync(path))
  } catch {
    return new Int16Array(0)
  }
}

/** Whole samples in a PCM file, without reading it; 0 when missing. */
export function pcmSampleCount(path: string): number {
  return Math.floor((fileSize(path) ?? 0) / 2)
}

// ── Mic pauses ────────────────────────────────────────────────────────────────
// While the mic is paused (by the user, or because the meeting app released the mic, i.e. muted)
// the helper writes silence. The spans are also kept next to the audio so every reader silences
// them again, together with a margin before each pause: an app's mute is only noticed a moment
// after the click, and what was said in that moment must not reach a transcript either.

export interface MicPauseSpan {
  /** mic.pcm sample index the pause applied from. */
  from: number
  /** Sample index the mic resumed at; null while (or if Echo stopped while) still paused. */
  to: number | null
}

export const MIC_PAUSES_FILE = 'mic-pauses.json'
/** Audio before each pause that is silenced too (1 s at 16 kHz). */
export const MIC_PAUSE_MARGIN_SAMPLES = 16_000

export function readMicPauses(dir: string): MicPauseSpan[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, MIC_PAUSES_FILE), 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is MicPauseSpan =>
        typeof s === 'object' &&
        s !== null &&
        Number.isSafeInteger(s.from) &&
        s.from >= 0 &&
        (s.to === null || (Number.isSafeInteger(s.to) && s.to >= s.from))
    )
  } catch {
    return []
  }
}

export function writeMicPauses(dir: string, spans: MicPauseSpan[]): void {
  writeFileSync(join(dir, MIC_PAUSES_FILE), JSON.stringify(spans), 'utf8')
}

/**
 * Silence (in place) every paused span plus its margin in `samples`, whose first sample is mic.pcm
 * index `offset`.
 */
export function silenceMicPauses(samples: Int16Array, spans: MicPauseSpan[], offset = 0): void {
  for (const span of spans) {
    const from = Math.max(0, span.from - MIC_PAUSE_MARGIN_SAMPLES - offset)
    const to = span.to === null ? samples.length : Math.min(samples.length, span.to - offset)
    if (to > from) samples.fill(0, from, to)
  }
}
