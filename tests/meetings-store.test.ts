import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'node:path'
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js'
import { MeetingsStore, type NewMeeting } from '../src/main/store/meetings'
import type { MeetingNotes, MeetingSpeaker } from '@shared/meeting-types'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})

function setup(onChange?: () => void): { db: Database; store: MeetingsStore } {
  const db = new SQL.Database()
  return { db, store: new MeetingsStore(db, onChange) }
}

function meeting(overrides: Partial<NewMeeting> = {}): NewMeeting {
  return {
    uuid: 'uuid-1',
    started_at: 1_000,
    app: 'google-meet',
    title: 'abc-defg-hij',
    audio_dir: 'C:/echo/meetings/uuid-1',
    name_hints: ['Blake Whitmore'],
    ...overrides
  }
}

const speaker: MeetingSpeaker = {
  key: 'others:SPEAKER_00',
  label: 'Blake Whitmore',
  source: 'voiceprint',
  personId: 3,
  suggestion: null,
  score: 0.81,
  seconds: 42.5
}

const notes: MeetingNotes = {
  summary: ['We moved the beta.'],
  decisions: [{ text: 'Beta moves to October 14.', cites: ['u3'], verification: 'supported', confidence: 0.95 }],
  actionItems: [
    { text: 'Send the checklist.', owner: 'Blake Whitmore', due: 'Friday', cites: ['u2'], verification: 'unverified' }
  ],
  openQuestions: [],
  model: 'claude-sonnet',
  verifiedBy: 'jev-1.13.0'
}

describe('MeetingsStore', () => {
  it('creates a recording meeting with empty defaults and notifies', () => {
    const onChange = vi.fn()
    const { store } = setup(onChange)
    const m = store.create(meeting())
    expect(m).toEqual({
      id: 1,
      uuid: 'uuid-1',
      started_at: 1_000,
      ended_at: null,
      app: 'google-meet',
      title: 'abc-defg-hij',
      status: 'recording',
      audio_dir: 'C:/echo/meetings/uuid-1',
      speakers: [],
      notes: null,
      name_hints: ['Blake Whitmore'],
      progress: null,
      error: null,
      output_path: null,
      participants: []
    })
    expect(store.get(m.id)).toEqual(m)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('returns null for a missing meeting', () => {
    const { store } = setup()
    expect(store.get(99)).toBeNull()
    expect(store.update(99, { status: 'ready' })).toBeNull()
  })

  it('round-trips speakers, notes and name hints through JSON columns on update', () => {
    const onChange = vi.fn()
    const { store } = setup(onChange)
    const { id } = store.create(meeting())
    const updated = store.update(id, {
      status: 'ready',
      ended_at: 5_000,
      speakers: [speaker],
      notes,
      name_hints: ['A', 'B'],
      progress: null,
      error: null,
      output_path: 'C:/Docs/Echo Meetings/x.md',
      title: 'Weekly sync'
    })
    expect(updated).toMatchObject({
      status: 'ready',
      ended_at: 5_000,
      speakers: [speaker],
      notes,
      name_hints: ['A', 'B'],
      output_path: 'C:/Docs/Echo Meetings/x.md',
      title: 'Weekly sync'
    })
    expect(store.get(id)).toEqual(updated)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('leaves fields the patch omits untouched and can clear nullable ones', () => {
    const { store } = setup()
    const { id } = store.create(meeting())
    store.update(id, { progress: 'Separating speakers…', notes })
    const m = store.update(id, { progress: null, audio_dir: null })!
    expect(m.progress).toBeNull()
    expect(m.audio_dir).toBeNull()
    expect(m.notes).toEqual(notes)
    expect(m.title).toBe('abc-defg-hij')
  })

  it('falls back to safe defaults when a JSON column is malformed', () => {
    const { db, store } = setup()
    const { id } = store.create(meeting())
    db.run(`UPDATE meetings SET speakers = 'not json', notes = '{"summary":', name_hints = '{"a":1}' WHERE id = ?`, [id])
    const m = store.get(id)!
    expect(m.speakers).toEqual([])
    expect(m.notes).toBeNull()
    expect(m.name_hints).toEqual([])

    db.run(`UPDATE meetings SET speakers = 'null', notes = '[1,2]', name_hints = '["ok", 3]' WHERE id = ?`, [id])
    const again = store.get(id)!
    expect(again.speakers).toEqual([])
    expect(again.notes).toBeNull()
    expect(again.name_hints).toEqual(['ok'])
  })

  it('lists newest first with a limit, and filters by status', () => {
    const { store } = setup()
    const a = store.create(meeting({ uuid: 'a', started_at: 100 }))
    const b = store.create(meeting({ uuid: 'b', started_at: 300 }))
    const c = store.create(meeting({ uuid: 'c', started_at: 200 }))
    expect(store.list().map((m) => m.uuid)).toEqual(['b', 'c', 'a'])
    expect(store.list(2).map((m) => m.uuid)).toEqual(['b', 'c'])
    store.update(a.id, { status: 'processing' })
    store.update(b.id, { status: 'ready' })
    expect(store.byStatus(['recording', 'processing']).map((m) => m.id)).toEqual([c.id, a.id])
    expect(store.byStatus(['failed'])).toEqual([])
    expect(store.byStatus([])).toEqual([])
  })

  it('appends segments with a per-meeting idx sequence and returns them in time order', () => {
    const onChange = vi.fn()
    const { store } = setup(onChange)
    const m1 = store.create(meeting({ uuid: 'm1' }))
    const m2 = store.create(meeting({ uuid: 'm2' }))
    onChange.mockClear()
    const s0 = store.appendSegment(m1.id, { start_ms: 5_000, end_ms: 6_000, channel: 'mic', speaker_key: 'me', text: 'second', pass: 'live' })
    const s1 = store.appendSegment(m1.id, { start_ms: 1_000, end_ms: 2_000, channel: 'others', speaker_key: 'others', text: 'first', pass: 'live' })
    const other = store.appendSegment(m2.id, { start_ms: 0, end_ms: 1, channel: 'mic', speaker_key: 'me', text: 'x', pass: 'live' })
    expect([s0.idx, s1.idx, other.idx]).toEqual([0, 1, 0])
    expect(s0).toMatchObject({ meeting_id: m1.id, channel: 'mic', speaker_key: 'me', text: 'second', pass: 'live' })
    expect(store.segments(m1.id).map((s) => s.text)).toEqual(['first', 'second'])
    expect(store.segments(m1.id)[0]).toEqual(s1)
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('replaces live and final segments with a fresh final pass', () => {
    const { store } = setup()
    const { id } = store.create(meeting())
    store.appendSegment(id, { start_ms: 0, end_ms: 1_000, channel: 'mic', speaker_key: 'me', text: 'live', pass: 'live' })
    store.replaceWithFinal(id, [
      { start_ms: 0, end_ms: 900, channel: 'mic', speaker_key: 'me', text: 'one' },
      { start_ms: 1_000, end_ms: 2_000, channel: 'others', speaker_key: 'others:SPEAKER_00', text: 'two' }
    ])
    const out = store.replaceWithFinal(id, [
      { start_ms: 1_000, end_ms: 2_000, channel: 'others', speaker_key: 'others:SPEAKER_00', text: 'b' },
      { start_ms: 0, end_ms: 900, channel: 'mic', speaker_key: 'me', text: 'a' }
    ])
    expect(out.map((s) => [s.idx, s.text, s.pass])).toEqual([
      [0, 'b', 'final'],
      [1, 'a', 'final']
    ])
    expect(store.segments(id).map((s) => s.text)).toEqual(['a', 'b'])
  })

  it('keeps the old segments when a final replacement fails part-way', () => {
    const { store } = setup()
    const { id } = store.create(meeting())
    store.appendSegment(id, { start_ms: 0, end_ms: 1_000, channel: 'mic', speaker_key: 'me', text: 'live', pass: 'live' })
    const broken = { start_ms: 1, end_ms: 2, channel: 'mic', speaker_key: 'me', text: null } as unknown as {
      start_ms: number; end_ms: number; channel: 'mic'; speaker_key: string; text: string
    }
    expect(() =>
      store.replaceWithFinal(id, [{ start_ms: 0, end_ms: 1, channel: 'mic', speaker_key: 'me', text: 'ok' }, broken])
    ).toThrow()
    expect(store.segments(id).map((s) => [s.text, s.pass])).toEqual([['live', 'live']])
    // The store is still usable after the rollback.
    expect(store.replaceWithFinal(id, [{ start_ms: 0, end_ms: 1, channel: 'mic', speaker_key: 'me', text: 'ok' }])).toHaveLength(1)
  })

  it('deletes a meeting together with its segments', () => {
    const onChange = vi.fn()
    const { db, store } = setup(onChange)
    const keep = store.create(meeting({ uuid: 'keep' }))
    const gone = store.create(meeting({ uuid: 'gone' }))
    store.appendSegment(keep.id, { start_ms: 0, end_ms: 1, channel: 'mic', speaker_key: 'me', text: 'k', pass: 'live' })
    store.appendSegment(gone.id, { start_ms: 0, end_ms: 1, channel: 'mic', speaker_key: 'me', text: 'g', pass: 'live' })
    onChange.mockClear()
    store.delete(gone.id)
    expect(store.get(gone.id)).toBeNull()
    expect(store.segments(gone.id)).toEqual([])
    expect(store.segments(keep.id)).toHaveLength(1)
    const stmt = db.prepare('SELECT COUNT(*) FROM meeting_segments WHERE meeting_id = ?')
    stmt.bind([gone.id])
    stmt.step()
    expect(stmt.get()[0]).toBe(0)
    stmt.free()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('finds finished meetings whose audio outlived the cutoff', () => {
    const { store } = setup()
    const ready = store.create(meeting({ uuid: 'ready' }))
    const failed = store.create(meeting({ uuid: 'failed' }))
    const recent = store.create(meeting({ uuid: 'recent' }))
    const pruned = store.create(meeting({ uuid: 'pruned' }))
    const processing = store.create(meeting({ uuid: 'processing' }))
    const recording = store.create(meeting({ uuid: 'recording' }))
    store.update(ready.id, { status: 'ready', ended_at: 100 })
    store.update(failed.id, { status: 'failed', ended_at: 200 })
    store.update(recent.id, { status: 'ready', ended_at: 1_000 })
    store.update(pruned.id, { status: 'ready', ended_at: 100, audio_dir: null })
    store.update(processing.id, { status: 'processing', ended_at: 100 })
    expect(recording.ended_at).toBeNull()
    expect(store.audioExpired(500).map((m) => m.uuid).sort()).toEqual(['failed', 'ready'])
  })

  it('reopens an existing database without losing rows', () => {
    const db = new SQL.Database()
    const first = new MeetingsStore(db)
    const { id } = first.create(meeting())
    const second = new MeetingsStore(db)
    expect(second.get(id)?.uuid).toBe('uuid-1')
  })

  it('trims live segments to the moment the meeting ended', () => {
    const { store } = setup()
    const { id } = store.create(meeting())
    const seg = (start_ms: number, end_ms: number, text: string) =>
      store.appendSegment(id, { start_ms, end_ms, channel: 'others', speaker_key: 'others', text, pass: 'live' })
    seg(0, 10_000, 'during')
    seg(8_000, 14_000, 'straddles')
    seg(12_000, 20_000, 'after')
    expect(store.deleteSegmentsAfter(id, 12_000)).toBe(1)
    expect(store.segments(id).map((s) => [s.text, s.start_ms, s.end_ms])).toEqual([
      ['during', 0, 10_000],
      ['straddles', 8_000, 12_000]
    ])
  })

  it('stores the meeting participants from the calendar', () => {
    const { store } = setup()
    const { id } = store.create(meeting())
    expect(store.get(id)!.participants).toEqual([])
    store.update(id, { participants: [{ name: 'Darin Kadiro', email: 'darin@example.com' }] })
    expect(store.get(id)!.participants).toEqual([{ name: 'Darin Kadiro', email: 'darin@example.com' }])
  })

  it('adds the participants column to a database created before it existed', () => {
    const db = new SQL.Database()
    db.run(`CREATE TABLE meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, started_at INTEGER NOT NULL,
      ended_at INTEGER, app TEXT NOT NULL, title TEXT, status TEXT NOT NULL, audio_dir TEXT, speakers TEXT NOT NULL DEFAULT '[]',
      notes TEXT, name_hints TEXT NOT NULL DEFAULT '[]', progress TEXT, error TEXT, output_path TEXT)`)
    db.run("INSERT INTO meetings (uuid, started_at, app, status) VALUES ('old', 1, 'teams', 'ready')")
    const store = new MeetingsStore(db)
    expect(store.list()[0]).toMatchObject({ uuid: 'old', participants: [] })
  })
})
