import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { FileSyncState } from '../src/main/sync/state'

const DIR = join(tmpdir(), 'echo-sync-state-test')
const FILE = join(DIR, 'sync-state.json')

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true })
})

describe('FileSyncState', () => {
  it('defaults every cursor and watermark to 0 before anything is written', () => {
    const s = new FileSyncState(FILE)
    expect(s.getCursor('transcripts')).toBe(0)
    expect(s.getWatermark('dictionary')).toBe(0)
  })

  it('persists cursors and watermarks across a reopen', () => {
    const a = new FileSyncState(FILE)
    a.setCursor('transcripts', 42)
    a.setWatermark('transcripts', 1700)
    a.setCursor('dictionary', 7)

    const b = new FileSyncState(FILE)
    expect(b.getCursor('transcripts')).toBe(42)
    expect(b.getWatermark('transcripts')).toBe(1700)
    expect(b.getCursor('dictionary')).toBe(7)
    expect(b.getWatermark('dictionary')).toBe(0) // never set ⇒ still default
  })

  it('keeps cursors and watermarks in separate namespaces for the same collection', () => {
    const s = new FileSyncState(FILE)
    s.setCursor('transcripts', 5)
    s.setWatermark('transcripts', 99)
    expect(s.getCursor('transcripts')).toBe(5)
    expect(s.getWatermark('transcripts')).toBe(99)
  })

  it('writes a JSON file under the given path, creating the parent directory', () => {
    const nested = join(DIR, 'deep', 'nested', 'sync-state.json')
    const s = new FileSyncState(nested)
    s.setCursor('transcripts', 3)
    expect(existsSync(nested)).toBe(true)
    const onDisk = JSON.parse(readFileSync(nested, 'utf8'))
    expect(onDisk.cursors.transcripts).toBe(3)
  })

  it('starts fresh (does not throw) when the state file is corrupt', () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(FILE, 'this is not json {{{')
    const s = new FileSyncState(FILE) // must self-heal — sync must never crash the app
    expect(s.getCursor('transcripts')).toBe(0)
    s.setCursor('transcripts', 11) // and remain usable, overwriting the bad file
    expect(new FileSyncState(FILE).getCursor('transcripts')).toBe(11)
  })

  it('does not leave a temp file behind (atomic write)', () => {
    const s = new FileSyncState(FILE)
    s.setWatermark('dictionary', 1)
    expect(existsSync(`${FILE}.tmp`)).toBe(false)
  })
})
