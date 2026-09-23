import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIC_PAUSE_MARGIN_SAMPLES,
  MIC_PAUSES_FILE,
  PcmTail,
  pcmSampleCount,
  readMicPauses,
  readPcmFile,
  silenceMicPauses,
  writeMicPauses
} from '../src/main/meetings/pcm-file'

function bytes(...samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2))
  return b
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'echo-pcm-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('PcmTail', () => {
  it('returns nothing (and no error) while the file does not exist yet', () => {
    const tail = new PcmTail(join(dir, 'mic.pcm'))
    expect(tail.read()).toEqual(new Int16Array(0))
    expect(tail.samplesRead).toBe(0)
  })

  it('returns only the bytes appended since the last read', () => {
    const path = join(dir, 'mic.pcm')
    const tail = new PcmTail(path)
    writeFileSync(path, bytes(1, 2, 3))
    expect(Array.from(tail.read())).toEqual([1, 2, 3])
    expect(tail.read()).toEqual(new Int16Array(0))
    appendFileSync(path, bytes(-4, 32767))
    expect(Array.from(tail.read())).toEqual([-4, 32767])
    expect(tail.samplesRead).toBe(5)
  })

  it('carries an odd trailing byte into the next read', () => {
    const path = join(dir, 'others.pcm')
    const tail = new PcmTail(path)
    const all = bytes(100, -200, 300)
    writeFileSync(path, all.subarray(0, 3)) // one whole sample and half of the next
    expect(Array.from(tail.read())).toEqual([100])
    appendFileSync(path, all.subarray(3))
    expect(Array.from(tail.read())).toEqual([-200, 300])
    expect(tail.samplesRead).toBe(3)
  })

  it('reads at most maxSamples at a time, continuing where it stopped', () => {
    const path = join(dir, 'mic.pcm')
    writeFileSync(path, bytes(1, 2, 3, 4, 5))
    const tail = new PcmTail(path)
    expect(Array.from(tail.read(2))).toEqual([1, 2])
    expect(Array.from(tail.read(2))).toEqual([3, 4])
    expect(Array.from(tail.read(2))).toEqual([5])
  })
})

describe('readPcmFile / pcmSampleCount', () => {
  it('reads a whole file as samples, ignoring a trailing odd byte', () => {
    const path = join(dir, 'mic.pcm')
    writeFileSync(path, Buffer.concat([bytes(7, -7), Buffer.from([1])]))
    expect(Array.from(readPcmFile(path))).toEqual([7, -7])
    expect(pcmSampleCount(path)).toBe(2)
  })

  it('treats a missing file as empty', () => {
    expect(readPcmFile(join(dir, 'nope.pcm')).length).toBe(0)
    expect(pcmSampleCount(join(dir, 'nope.pcm'))).toBe(0)
  })
})

describe('mic pauses', () => {
  it('round-trips the spans file and ignores a corrupt one', () => {
    expect(readMicPauses(dir)).toEqual([])
    writeMicPauses(dir, [{ from: 32_000, to: 48_000 }, { from: 64_000, to: null }])
    expect(readMicPauses(dir)).toEqual([{ from: 32_000, to: 48_000 }, { from: 64_000, to: null }])
    writeFileSync(join(dir, MIC_PAUSES_FILE), '{"not":"a list"}')
    expect(readMicPauses(dir)).toEqual([])
  })

  it('silences each span and the second before it; an open span runs to the end', () => {
    const samples = new Int16Array(100_000).fill(7)
    silenceMicPauses(samples, [{ from: 40_000, to: 50_000 }, { from: 90_000, to: null }])
    expect(samples[40_000 - MIC_PAUSE_MARGIN_SAMPLES - 1]).toBe(7)
    expect(samples.subarray(40_000 - MIC_PAUSE_MARGIN_SAMPLES, 50_000).every((s) => s === 0)).toBe(true)
    expect(samples[50_000]).toBe(7)
    expect(samples.subarray(90_000 - MIC_PAUSE_MARGIN_SAMPLES).every((s) => s === 0)).toBe(true)
  })

  it('works on a slice that starts later in the file', () => {
    const slice = new Int16Array(20_000).fill(5) // mic.pcm samples [100000, 120000)
    silenceMicPauses(slice, [{ from: 125_000, to: 130_000 }], 100_000)
    // The margin before the pause reaches back into the slice.
    expect(slice[9_000 - 1]).toBe(5)
    expect(slice.subarray(9_000).every((s) => s === 0)).toBe(true)
  })
})
