// ─────────────────────────────────────────────────────────────────────────────
// Meeting audio helpers over the helper's raw 16 kHz mono s16le PCM: decoding, WAV wrapping, a
// small energy VAD (so silent chunks never reach a speech model), and where to cut the live
// transcript's chunks. Pure: typed arrays in, numbers out.
// ─────────────────────────────────────────────────────────────────────────────

import { MEETING_SAMPLE_RATE } from './meeting-types'

/** Little-endian signed 16-bit samples; a trailing odd byte is ignored. */
export function pcm16FromBytes(bytes: Uint8Array): Int16Array {
  const count = Math.floor(bytes.byteLength / 2)
  const out = new Int16Array(count)
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2)
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true)
  return out
}

/** Mono PCM16 WAV (default 16 kHz) with the samples written verbatim. */
export function int16ToWav(samples: Int16Array, rate = MEETING_SAMPLE_RATE): ArrayBuffer {
  const dataSize = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataSize, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true)
  return buffer
}

/** RMS (0..1) of each whole `frameMs` frame; a trailing partial frame is ignored. */
export function frameRms(samples: Int16Array, frameMs = 30, rate = MEETING_SAMPLE_RATE): Float32Array {
  const size = Math.max(1, Math.round((rate * frameMs) / 1000))
  const frames = Math.floor(samples.length / size)
  const out = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = f * size; i < (f + 1) * size; i++) {
      const v = samples[i] / 32768
      sum += v * v
    }
    out[f] = Math.sqrt(sum / size)
  }
  return out
}

const VAD_FRAME_MS = 30
/** −48 dBFS: below this nothing counts as speech, however quiet the room. */
const VAD_ABS_FLOOR = Math.pow(10, -48 / 20)
/** −35 dBFS: the noise floor is never taken above this, or a talker who never pauses would judge
 * their own speech to be the floor and every chunk would count as silent. */
const VAD_NOISE_CEILING = Math.pow(10, -35 / 20)
const VAD_NOISE_FACTOR = 3
const VAD_NOISE_PERCENTILE = 0.2

/**
 * Seconds of speech by frame energy: a 30 ms frame is speech when its RMS clears both −48 dBFS and
 * 3× the chunk's noise floor (its 20th-percentile frame RMS, capped at −35 dBFS). Runs of a single
 * frame (clicks) don't count.
 */
export function speechSeconds(samples: Int16Array, rate = MEETING_SAMPLE_RATE): number {
  const rms = frameRms(samples, VAD_FRAME_MS, rate)
  if (rms.length === 0) return 0
  const sorted = Float32Array.from(rms).sort()
  const noise = Math.min(VAD_NOISE_CEILING, sorted[Math.floor((sorted.length - 1) * VAD_NOISE_PERCENTILE)])
  const threshold = Math.max(VAD_ABS_FLOOR, noise * VAD_NOISE_FACTOR)
  let frames = 0
  let run = 0
  for (let i = 0; i <= rms.length; i++) {
    if (i < rms.length && rms[i] > threshold) {
      run++
      continue
    }
    if (run >= 2) frames += run
    run = 0
  }
  const frameSamples = Math.max(1, Math.round((rate * VAD_FRAME_MS) / 1000))
  return (frames * frameSamples) / rate
}

/** Too little speech to be worth sending to a model (and a hallucination risk if sent). */
export function isSilentChunk(samples: Int16Array, rate = MEETING_SAMPLE_RATE): boolean {
  return speechSeconds(samples, rate) < 0.4
}

/**
 * The sample index at the centre of the lowest-energy `windowMs` window lying inside [from, to);
 * the earliest wins a tie. A range shorter than the window yields its middle.
 */
export function quietestPoint(
  samples: Int16Array,
  from: number,
  to: number,
  windowMs = 300,
  rate = MEETING_SAMPLE_RATE
): number {
  const lo = Math.max(0, Math.min(Math.floor(from), samples.length))
  const hi = Math.max(lo, Math.min(Math.floor(to), samples.length))
  const win = Math.max(1, Math.round((rate * windowMs) / 1000))
  if (hi - lo <= win) return lo + Math.floor((hi - lo) / 2)
  // Sliding sum of squares, one sample at a time.
  let energy = 0
  for (let i = lo; i < lo + win; i++) energy += samples[i] * samples[i]
  let best = energy
  let bestStart = lo
  for (let start = lo + 1; start + win <= hi; start++) {
    const out = samples[start - 1]
    const inn = samples[start + win - 1]
    energy += inn * inn - out * out
    if (energy < best) {
      best = energy
      bestStart = start
    }
  }
  return bestStart + Math.floor(win / 2)
}

export interface LiveCutOptions {
  /** Pending audio needed before any cut. */
  minPendingS: number
  /** Earliest cut point. */
  searchFromS: number
  /** Latest cut point while under `maxS`. */
  searchToS: number
  /** Pending audio that forces a cut before this point. */
  maxS: number
}

const DEFAULT_LIVE_CUT: LiveCutOptions = { minPendingS: 12, searchFromS: 8, searchToS: 25, maxS: 30 }

/**
 * Where to end the next live chunk (a sample count), or null to wait for more audio. At stop the
 * whole remainder goes.
 */
export function planLiveCut(
  pending: Int16Array,
  final: boolean,
  opts: Partial<LiveCutOptions> = {},
  rate = MEETING_SAMPLE_RATE
): number | null {
  const o = { ...DEFAULT_LIVE_CUT, ...opts }
  if (final) return pending.length > 0 ? pending.length : null
  if (pending.length < o.minPendingS * rate) return null
  const from = Math.round(o.searchFromS * rate)
  const to = pending.length >= o.maxS * rate ? Math.round(o.maxS * rate) : Math.min(Math.round(o.searchToS * rate), pending.length)
  return quietestPoint(pending, from, to, 300, rate)
}
