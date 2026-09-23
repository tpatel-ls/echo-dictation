import { describe, it, expect } from 'vitest'
import {
  frameRms,
  int16ToWav,
  isSilentChunk,
  pcm16FromBytes,
  planLiveCut,
  quietestPoint,
  speechSeconds
} from '@shared/meeting-audio'

const RATE = 16_000

/** Deterministic pseudo-random generator so the noise fixtures never change. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Build audio from [seconds, amplitude (0..1), kind] parts over a faint noise bed. */
function audio(parts: Array<[number, number, 'tone' | 'noise']>, bed = 0.0005): Int16Array {
  const rand = rng(7)
  const total = parts.reduce((n, [s]) => n + Math.round(s * RATE), 0)
  const out = new Int16Array(total)
  let i = 0
  for (const [seconds, amp, kind] of parts) {
    const n = Math.round(seconds * RATE)
    for (let k = 0; k < n; k++, i++) {
      // Syllable-rate modulation gives "speech" natural dips instead of a flat tone.
      const env = kind === 'tone' ? 0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * k) / RATE) : 1
      const sig = kind === 'tone' ? Math.sin((2 * Math.PI * 220 * k) / RATE) * env : rand() * 2 - 1
      const v = amp * sig + bed * (rand() * 2 - 1)
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)))
    }
  }
  return out
}

describe('pcm16FromBytes', () => {
  it('reads little-endian samples and ignores a trailing odd byte', () => {
    const bytes = new Uint8Array([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x42])
    expect(Array.from(pcm16FromBytes(bytes))).toEqual([1, 32767, -32768])
  })

  it('reads a view at an odd offset into a larger buffer', () => {
    const backing = new Uint8Array([9, 0x02, 0x00, 0xfe, 0xff])
    expect(Array.from(pcm16FromBytes(backing.subarray(1)))).toEqual([2, -2])
  })
})

describe('int16ToWav', () => {
  it('writes a 16 kHz mono PCM16 WAV with the samples verbatim', () => {
    const wav = int16ToWav(new Int16Array([0, 1000, -1000]))
    const v = new DataView(wav)
    const str = (o: number) => String.fromCharCode(...new Uint8Array(wav, o, 4))
    expect(str(0)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 6)
    expect(str(8)).toBe('WAVE')
    expect(v.getUint16(20, true)).toBe(1)
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint32(24, true)).toBe(16_000)
    expect(v.getUint32(28, true)).toBe(32_000)
    expect(v.getUint16(34, true)).toBe(16)
    expect(str(36)).toBe('data')
    expect(v.getUint32(40, true)).toBe(6)
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([0, 1000, -1000])
  })

  it('honours another rate', () => {
    expect(new DataView(int16ToWav(new Int16Array(1), 8000)).getUint32(24, true)).toBe(8000)
  })
})

describe('frameRms', () => {
  it('returns one 0..1 value per whole 30 ms frame', () => {
    const s = new Int16Array(480 * 2 + 100)
    s.fill(16384, 480, 960)
    const rms = frameRms(s)
    expect(rms).toHaveLength(2)
    expect(rms[0]).toBe(0)
    expect(rms[1]).toBeCloseTo(0.5, 3)
  })
})

describe('speechSeconds', () => {
  it('is zero for digital silence and dither-level noise', () => {
    expect(speechSeconds(new Int16Array(RATE * 5))).toBe(0)
    expect(speechSeconds(audio([[5, 0, 'noise']], 0.002))).toBe(0)
  })

  it('measures speech bursts against the noise floor', () => {
    const s = audio([
      [2, 0, 'noise'],
      [1.5, 0.3, 'tone'],
      [2, 0, 'noise'],
      [1, 0.3, 'tone'],
      [1, 0, 'noise']
    ])
    expect(speechSeconds(s)).toBeGreaterThan(2.2)
    expect(speechSeconds(s)).toBeLessThan(2.8)
  })

  it('needs speech above 3x the noise floor, not just above the absolute floor', () => {
    // A loud, steady noise bed with bursts barely above it is not speech.
    const s = audio([
      [2, 0.05, 'noise'],
      [1, 0.07, 'noise'],
      [2, 0.05, 'noise']
    ])
    expect(speechSeconds(s)).toBe(0)
  })

  it('counts dense speech that never pauses (the noise floor is capped at -35 dBFS)', () => {
    // A fast talker: loudness only dips to half, so every frame sits near the 20th percentile.
    const s = new Int16Array(RATE * 12)
    for (let k = 0; k < s.length; k++) {
      const env = 0.75 + 0.25 * Math.sin((2 * Math.PI * 4 * k) / RATE)
      s[k] = Math.round(0.3 * env * Math.sin((2 * Math.PI * 220 * k) / RATE) * 32767)
    }
    expect(speechSeconds(s)).toBeGreaterThan(11)
    expect(isSilentChunk(s)).toBe(false)
  })

  it('does not count isolated single-frame clicks', () => {
    const s = new Int16Array(RATE * 3)
    // Each click sits inside one 30 ms (480-sample) frame.
    for (const frame of [16, 40, 80]) s.fill(12000, frame * 480 + 40, frame * 480 + 440)
    expect(speechSeconds(s)).toBe(0)
    // Two adjacent loud frames do count.
    s.fill(12000, 60 * 480, 62 * 480)
    expect(speechSeconds(s)).toBeCloseTo(0.06, 5)
  })
})

describe('isSilentChunk', () => {
  it('flags chunks with under 0.4 s of speech', () => {
    expect(isSilentChunk(new Int16Array(RATE * 12))).toBe(true)
    expect(isSilentChunk(audio([[5, 0, 'noise'], [0.2, 0.3, 'tone'], [5, 0, 'noise']]))).toBe(true)
    expect(isSilentChunk(audio([[5, 0, 'noise'], [1, 0.3, 'tone'], [5, 0, 'noise']]))).toBe(false)
  })
})

describe('quietestPoint', () => {
  it('returns the centre of the quietest 300 ms window in range', () => {
    const s = audio([
      [3, 0.3, 'tone'],
      [0.5, 0, 'noise'],
      [3, 0.3, 'tone']
    ])
    const at = quietestPoint(s, 0, s.length)
    expect(at / RATE).toBeGreaterThan(3.1)
    expect(at / RATE).toBeLessThan(3.4)
  })

  it('only looks inside [from, to)', () => {
    const s = audio([
      [1, 0, 'noise'],
      [2, 0.3, 'tone'],
      [0.5, 0.02, 'tone'],
      [2, 0.3, 'tone']
    ])
    const at = quietestPoint(s, 2 * RATE, s.length)
    expect(at / RATE).toBeGreaterThan(3)
    expect(at / RATE).toBeLessThan(3.5)
  })

  it('returns the middle of a range shorter than the window', () => {
    expect(quietestPoint(new Int16Array(RATE), 1000, 2000)).toBe(1500)
  })
})

describe('planLiveCut', () => {
  it('waits until 12 s are pending', () => {
    expect(planLiveCut(audio([[11.9, 0.3, 'tone']]), false)).toBeNull()
    expect(planLiveCut(new Int16Array(0), false)).toBeNull()
  })

  it('flushes everything at stop, or nothing when empty', () => {
    expect(planLiveCut(new Int16Array(500), true)).toBe(500)
    expect(planLiveCut(new Int16Array(0), true)).toBeNull()
  })

  it('cuts at the quietest point between 8 s and the end of what is pending', () => {
    const s = audio([
      [10, 0.3, 'tone'],
      [0.6, 0, 'noise'],
      [3, 0.3, 'tone']
    ])
    const cut = planLiveCut(s, false)!
    expect(cut / RATE).toBeGreaterThan(10)
    expect(cut / RATE).toBeLessThan(10.6)
  })

  it('ignores a pause before 8 s', () => {
    const s = audio([
      [3, 0.3, 'tone'],
      [1, 0, 'noise'],
      [6, 0.3, 'tone'],
      [0.4, 0.05, 'tone'],
      [3, 0.3, 'tone']
    ])
    const cut = planLiveCut(s, false)!
    expect(cut / RATE).toBeGreaterThan(10)
    expect(cut / RATE).toBeLessThan(10.4)
  })

  it('searches no later than 25 s', () => {
    const s = audio([
      [20, 0.3, 'tone'],
      [0.5, 0.1, 'tone'],
      [6, 0.3, 'tone'],
      [1, 0, 'noise']
    ])
    const cut = planLiveCut(s, false)!
    expect(cut / RATE).toBeGreaterThan(20)
    expect(cut / RATE).toBeLessThan(20.5)
  })

  it('forces a cut before 30 s once that much is pending', () => {
    const s = audio([[40, 0.3, 'tone']])
    const cut = planLiveCut(s, false)!
    expect(cut).toBeGreaterThanOrEqual(8 * RATE)
    expect(cut).toBeLessThan(30 * RATE)
  })

  it('accepts other options', () => {
    const s = audio([[2, 0.3, 'tone'], [0.5, 0, 'noise'], [2, 0.3, 'tone']])
    const cut = planLiveCut(s, false, { minPendingS: 4, searchFromS: 1, searchToS: 4 })!
    expect(cut / RATE).toBeGreaterThan(2)
    expect(cut / RATE).toBeLessThan(2.5)
  })
})
