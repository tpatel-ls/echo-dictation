import type { Database, SqlValue } from 'sql.js'
import type {
  MeetingAppId,
  MeetingChannel,
  MeetingNotes,
  MeetingParticipant,
  MeetingRecord,
  MeetingSegment,
  MeetingSpeaker,
  MeetingStatus
} from '@shared/meeting-types'

// Recorded meetings and their transcript segments over the shared sql.js database. Meetings stay
// on this PC: no sync columns. Speakers, notes and name hints live in JSON columns.

export type NewMeeting = Pick<MeetingRecord, 'uuid' | 'started_at' | 'app' | 'title' | 'audio_dir' | 'name_hints'>
export type MeetingPatch = Partial<Omit<MeetingRecord, 'id' | 'uuid'>>
export type NewSegment = Omit<MeetingSegment, 'id' | 'meeting_id' | 'idx'>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  app TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  audio_dir TEXT,
  speakers TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  name_hints TEXT NOT NULL DEFAULT '[]',
  progress TEXT,
  error TEXT,
  output_path TEXT,
  participants TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_meetings_started ON meetings(started_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS meeting_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  channel TEXT NOT NULL,
  speaker_key TEXT NOT NULL,
  text TEXT NOT NULL,
  pass TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meeting_segments_order ON meeting_segments(meeting_id, start_ms, idx);
`

/** Patchable columns; JSON ones are serialised on the way in and parsed defensively on the way out. */
const PLAIN_COLUMNS = ['started_at', 'ended_at', 'app', 'title', 'status', 'audio_dir', 'progress', 'error', 'output_path'] as const
const JSON_COLUMNS = ['speakers', 'notes', 'name_hints', 'participants'] as const

/** Pure SQL meetings store over a sql.js Database. No filesystem, so it is testable in memory. */
export class MeetingsStore {
  constructor(
    private db: Database,
    private onChange: () => void = () => {}
  ) {
    this.db.run(SCHEMA)
    // Databases from before calendar participants existed.
    const columns = this.db.exec('PRAGMA table_info(meetings)')[0]?.values.map((row) => row[1]) ?? []
    if (!columns.includes('participants')) this.db.run("ALTER TABLE meetings ADD COLUMN participants TEXT NOT NULL DEFAULT '[]'")
  }

  create(m: NewMeeting): MeetingRecord {
    this.db.run(
      `INSERT INTO meetings (uuid, started_at, ended_at, app, title, status, audio_dir, speakers, notes, name_hints)
       VALUES (?,?,NULL,?,?,'recording',?,'[]',NULL,?)`,
      [m.uuid, m.started_at, m.app, m.title, m.audio_dir, JSON.stringify(m.name_hints)]
    )
    const id = this.scalar('SELECT last_insert_rowid()', [])
    this.onChange()
    return this.get(id)!
  }

  get(id: number): MeetingRecord | null {
    return this.meetings('SELECT * FROM meetings WHERE id = ?', [id])[0] ?? null
  }

  list(limit = 500): MeetingRecord[] {
    return this.meetings('SELECT * FROM meetings ORDER BY started_at DESC, id DESC LIMIT ?', [limit])
  }

  byStatus(statuses: MeetingStatus[]): MeetingRecord[] {
    if (!statuses.length) return []
    return this.meetings(
      `SELECT * FROM meetings WHERE status IN (${statuses.map(() => '?').join(',')})
       ORDER BY started_at DESC, id DESC`,
      statuses
    )
  }

  update(id: number, patch: MeetingPatch): MeetingRecord | null {
    if (!this.get(id)) return null
    const sets: string[] = []
    const params: SqlValue[] = []
    for (const column of PLAIN_COLUMNS) {
      if (patch[column] === undefined) continue
      sets.push(`${column} = ?`)
      params.push(patch[column] as SqlValue)
    }
    for (const column of JSON_COLUMNS) {
      if (patch[column] === undefined) continue
      sets.push(`${column} = ?`)
      params.push(patch[column] === null ? null : JSON.stringify(patch[column]))
    }
    if (sets.length) {
      this.db.run(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`, [...params, id])
      this.onChange()
    }
    return this.get(id)
  }

  /** Remove a meeting and every segment it owns. */
  delete(id: number): void {
    this.transaction(() => {
      this.db.run('DELETE FROM meeting_segments WHERE meeting_id = ?', [id])
      this.db.run('DELETE FROM meetings WHERE id = ?', [id])
    })
    this.onChange()
  }

  appendSegment(meetingId: number, seg: NewSegment): MeetingSegment {
    const idx = this.nextIdx(meetingId)
    const segment = this.insertSegment(meetingId, idx, seg)
    this.onChange()
    return segment
  }

  /**
   * Swap the live transcript (and any earlier final pass) for a new final pass in one transaction,
   * so a failure part-way leaves the previous segments intact.
   */
  replaceWithFinal(meetingId: number, segs: Array<Omit<NewSegment, 'pass'>>): MeetingSegment[] {
    const out = this.transaction(() => {
      this.db.run('DELETE FROM meeting_segments WHERE meeting_id = ?', [meetingId])
      return segs.map((seg, idx) => this.insertSegment(meetingId, idx, { ...seg, pass: 'final' }))
    })
    this.onChange()
    return out
  }

  /**
   * Cut the transcript at `ms` (the moment the meeting ended): segments starting there or later are
   * deleted, one that straddles it ends there. Returns how many were deleted.
   */
  deleteSegmentsAfter(meetingId: number, ms: number): number {
    const doomed = this.scalar('SELECT COUNT(*) FROM meeting_segments WHERE meeting_id = ? AND start_ms >= ?', [meetingId, ms])
    this.db.run('DELETE FROM meeting_segments WHERE meeting_id = ? AND start_ms >= ?', [meetingId, ms])
    this.db.run('UPDATE meeting_segments SET end_ms = ? WHERE meeting_id = ? AND end_ms > ?', [ms, meetingId, ms])
    this.onChange()
    return doomed
  }

  segments(meetingId: number): MeetingSegment[] {
    const stmt = this.db.prepare('SELECT * FROM meeting_segments WHERE meeting_id = ? ORDER BY start_ms, idx')
    stmt.bind([meetingId])
    const rows: MeetingSegment[] = []
    while (stmt.step()) rows.push(toSegment(stmt.getAsObject()))
    stmt.free()
    return rows
  }

  /** Finished meetings whose audio is still on disk and ended before `cutoff` (epoch ms). */
  audioExpired(cutoff: number): MeetingRecord[] {
    return this.meetings(
      `SELECT * FROM meetings
       WHERE status IN ('ready', 'failed') AND ended_at IS NOT NULL AND ended_at < ? AND audio_dir IS NOT NULL
       ORDER BY ended_at, id`,
      [cutoff]
    )
  }

  private insertSegment(meetingId: number, idx: number, seg: NewSegment): MeetingSegment {
    this.db.run(
      `INSERT INTO meeting_segments (meeting_id, idx, start_ms, end_ms, channel, speaker_key, text, pass)
       VALUES (?,?,?,?,?,?,?,?)`,
      [meetingId, idx, seg.start_ms, seg.end_ms, seg.channel, seg.speaker_key, seg.text, seg.pass]
    )
    return { id: this.scalar('SELECT last_insert_rowid()', []), meeting_id: meetingId, idx, ...seg }
  }

  private nextIdx(meetingId: number): number {
    return this.scalar('SELECT COALESCE(MAX(idx) + 1, 0) FROM meeting_segments WHERE meeting_id = ?', [meetingId])
  }

  private transaction<T>(work: () => T): T {
    this.db.run('BEGIN')
    try {
      const out = work()
      this.db.run('COMMIT')
      return out
    } catch (e) {
      this.db.run('ROLLBACK')
      throw e
    }
  }

  private meetings(sql: string, params: SqlValue[]): MeetingRecord[] {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const rows: MeetingRecord[] = []
    while (stmt.step()) rows.push(toMeeting(stmt.getAsObject()))
    stmt.free()
    return rows
  }

  private scalar(sql: string, params: SqlValue[]): number {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    let v = 0
    if (stmt.step()) v = (stmt.get()[0] as number) ?? 0
    stmt.free()
    return v
  }
}

function toMeeting(o: Record<string, SqlValue>): MeetingRecord {
  return {
    id: o.id as number,
    uuid: o.uuid as string,
    started_at: o.started_at as number,
    ended_at: (o.ended_at as number | null) ?? null,
    app: o.app as MeetingAppId,
    title: (o.title as string | null) ?? null,
    status: o.status as MeetingStatus,
    audio_dir: (o.audio_dir as string | null) ?? null,
    speakers: parseArray<MeetingSpeaker>(o.speakers, (s) => typeof s === 'object' && s !== null),
    notes: parseNotes(o.notes),
    name_hints: parseArray<string>(o.name_hints, (s) => typeof s === 'string'),
    progress: (o.progress as string | null) ?? null,
    error: (o.error as string | null) ?? null,
    output_path: (o.output_path as string | null) ?? null,
    participants: parseArray<MeetingParticipant>(
      o.participants,
      (p) => typeof p === 'object' && p !== null && typeof (p as MeetingParticipant).name === 'string'
    )
  }
}

function toSegment(o: Record<string, SqlValue>): MeetingSegment {
  return {
    id: o.id as number,
    meeting_id: o.meeting_id as number,
    idx: o.idx as number,
    start_ms: o.start_ms as number,
    end_ms: o.end_ms as number,
    channel: o.channel as MeetingChannel,
    speaker_key: o.speaker_key as string,
    text: o.text as string,
    pass: o.pass as MeetingSegment['pass']
  }
}

function parseJson(value: SqlValue): unknown {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** A corrupt JSON column reads as an empty list (dropping malformed entries), never a throw. */
function parseArray<T>(value: SqlValue, keep: (entry: unknown) => boolean): T[] {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? (parsed.filter(keep) as T[]) : []
}

const NOTE_LISTS = ['summary', 'decisions', 'actionItems', 'openQuestions'] as const

function parseNotes(value: SqlValue): MeetingNotes | null {
  const parsed = parseJson(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const notes = parsed as Record<string, unknown>
  return NOTE_LISTS.every((key) => Array.isArray(notes[key])) ? (notes as unknown as MeetingNotes) : null
}
