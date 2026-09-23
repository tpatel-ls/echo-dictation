import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { MeetingsStore } from '../src/main/store/meetings'
import { pruneMeetingAudio, scheduleRetention } from '../src/main/meetings/retention'
import type { MeetingStatus } from '@shared/meeting-types'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')
const DAY = 86_400_000
const NOW = 100 * DAY

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'echo-retention-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})

function setup() {
  const meetings = new MeetingsStore(new SQL.Database())
  const meetingsDir = path.join(root, 'meetings')
  const add = (uuid: string, endedDaysAgo: number, status: MeetingStatus = 'ready', audioDir?: string) => {
    const dir = audioDir ?? path.join(meetingsDir, uuid)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'mic.pcm'), Buffer.alloc(4))
    mkdirSync(meetingsDir, { recursive: true })
    writeFileSync(path.join(meetingsDir, `${uuid}.speakers.json`), '{}')
    const row = meetings.create({ uuid, started_at: NOW - endedDaysAgo * DAY - 60_000, app: 'teams', title: null, audio_dir: dir, name_hints: [] })
    meetings.update(row.id, { status, ended_at: NOW - endedDaysAgo * DAY })
    return { id: row.id, dir }
  }
  return { meetings, meetingsDir, add }
}

describe('pruneMeetingAudio', () => {
  it('deletes audio older than the retention window and clears audio_dir', () => {
    const { meetings, meetingsDir, add } = setup()
    const old = add('old', 31)
    const failed = add('failed', 40, 'failed')
    const fresh = add('fresh', 29)
    const pruned = pruneMeetingAudio({ meetings, meetingsDir, retainDays: () => 30, now: () => NOW })
    expect(pruned).toBe(2)
    expect(existsSync(old.dir)).toBe(false)
    expect(existsSync(failed.dir)).toBe(false)
    expect(meetings.get(old.id)!.audio_dir).toBeNull()
    expect(existsSync(fresh.dir)).toBe(true)
    expect(meetings.get(fresh.id)!.audio_dir).toBe(fresh.dir)
    // The voices file lives next to the audio directory and is kept.
    expect(existsSync(path.join(meetingsDir, 'old.speakers.json'))).toBe(true)
  })

  it('never touches a meeting still recording or processing', () => {
    const { meetings, meetingsDir, add } = setup()
    const processing = add('p', 90, 'processing')
    pruneMeetingAudio({ meetings, meetingsDir, retainDays: () => 1, now: () => NOW })
    expect(existsSync(processing.dir)).toBe(true)
  })

  it('with 0 days deletes every finished meeting\'s audio', () => {
    const { meetings, meetingsDir, add } = setup()
    const recent = add('recent', 0.001)
    pruneMeetingAudio({ meetings, meetingsDir, retainDays: () => 0, now: () => NOW })
    expect(existsSync(recent.dir)).toBe(false)
  })

  it('refuses to delete a directory outside the meetings folder', () => {
    const { meetings, meetingsDir, add } = setup()
    const outside = add('x', 90, 'ready', path.join(root, 'elsewhere'))
    const logs: string[] = []
    pruneMeetingAudio({ meetings, meetingsDir, retainDays: () => 30, now: () => NOW, log: (m) => logs.push(m) })
    expect(existsSync(outside.dir)).toBe(true)
    expect(meetings.get(outside.id)!.audio_dir).toBe(outside.dir)
    expect(logs.join('\n')).toContain('outside')
  })
})

describe('scheduleRetention', () => {
  it('prunes on start and again every interval', () => {
    vi.useFakeTimers()
    const { meetings, meetingsDir } = setup()
    const retainDays = vi.fn(() => 30)
    const stop = scheduleRetention({ meetings, meetingsDir, retainDays, now: () => NOW }, 1000)
    expect(retainDays).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2500)
    expect(retainDays).toHaveBeenCalledTimes(3)
    stop()
    vi.advanceTimersByTime(5000)
    expect(retainDays).toHaveBeenCalledTimes(3)
  })
})
