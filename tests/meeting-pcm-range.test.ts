import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPcmRange, silenceMicPauses } from '../src/main/meetings/pcm-file'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('bounded final-pass PCM reads', () => {
  it('reads only the requested clip at its original offset and reapplies mic pauses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-pcm-range-'))
    dirs.push(dir)
    const path = join(dir, 'mic.pcm')
    const pcm = Buffer.alloc(80_000)
    for (let i = 0; i < 40_000; i++) pcm.writeInt16LE(i % 2 ? -1234 : 5678, i * 2)
    writeFileSync(path, pcm)
    const clip = readPcmRange(path, 20_000, 20_004)
    expect([...clip]).toEqual([5678, -1234, 5678, -1234])
    silenceMicPauses(clip, [{ from: 36_002, to: null }], 20_000)
    expect([...clip]).toEqual([5678, -1234, 0, 0])
    expect(() => readPcmRange(path, 39_999, 40_001)).toThrow()
  })
})
