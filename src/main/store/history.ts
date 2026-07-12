import type { Database, SqlValue } from 'sql.js'
import type { HistoryQueryOpts, NewTranscript, Stats, Transcript, TranscriptStatus } from '@shared/types'
import { estimatedSecondsSaved, wordCount } from '@shared/format'
import { ensureSyncColumns } from './migrate'
import { monotonicClock } from './clock'
import { randomUUID } from 'node:crypto'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  cleaned_text TEXT,
  duration_ms INTEGER NOT NULL,
  word_count INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  app_context TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  audio_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_transcripts_created ON transcripts(created_at DESC, id DESC);
`

const DAY_MS = 86_400_000

/** Pure SQL history store over a sql.js Database. No filesystem — testable in memory. */
export class HistoryStore {
  constructor(
    private db: Database,
    private onChange: () => void = () => {},
    private now: () => number = monotonicClock()
  ) {
    this.db.run(SCHEMA)
    ensureSyncColumns(this.db, 'transcripts')
  }

  insert(t: NewTranscript): Transcript {
    this.db.run(
      `INSERT INTO transcripts
       (created_at, raw_text, cleaned_text, duration_ms, word_count, latency_ms, app_context, model, status, audio_path, uuid, updated_at, deleted)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [
        t.created_at,
        t.raw_text,
        t.cleaned_text,
        t.duration_ms,
        t.word_count,
        t.latency_ms,
        t.app_context,
        t.model,
        t.status,
        t.audio_path,
        randomUUID(),
        this.now()
      ]
    )
    const id = this.scalar('SELECT last_insert_rowid()', [])
    this.onChange()
    return { id, ...t }
  }

  get(id: number): Transcript | null {
    return this.query('SELECT * FROM transcripts WHERE id = ? AND deleted = 0', [id])[0] ?? null
  }

  list(opts: HistoryQueryOpts): Transcript[] {
    return this.filteredQuery(opts)
  }

  listAll(): Transcript[] {
    return this.query(
      'SELECT * FROM transcripts WHERE deleted = 0 ORDER BY created_at DESC, id DESC',
      []
    )
  }

  search(q: string, opts: HistoryQueryOpts): Transcript[] {
    return this.filteredQuery(opts, q)
  }

  /**
   * Apply a user edit to the text the dashboard displays: cleaned_text when present,
   * raw_text otherwise. Keeps word_count in sync with what was actually kept.
   */
  updateEdited(id: number, text: string): Transcript | null {
    const cur = this.get(id)
    if (!cur) return null
    const column = cur.cleaned_text !== null ? 'cleaned_text' : 'raw_text'
    this.db.run(`UPDATE transcripts SET ${column} = ?, word_count = ?, updated_at = ? WHERE id = ?`, [
      text,
      wordCount(text),
      this.now(),
      id
    ])
    this.onChange()
    return this.get(id)
  }

  updateCleaned(id: number, cleaned: string): Transcript | null {
    this.db.run('UPDATE transcripts SET cleaned_text = ?, updated_at = ? WHERE id = ?', [
      cleaned,
      this.now(),
      id
    ])
    this.onChange()
    return this.get(id)
  }

  updateRetried(
    id: number,
    result: { rawText: string; cleanedText: string | null; model: string; latencyMs: number }
  ): Transcript | null {
    if (!this.get(id)) return null
    const keptText = result.cleanedText ?? result.rawText
    this.db.run(
      `UPDATE transcripts
       SET raw_text = ?, cleaned_text = ?, word_count = ?, latency_ms = ?, model = ?, status = 'ok', updated_at = ?
       WHERE id = ?`,
      [
        result.rawText,
        result.cleanedText,
        wordCount(keptText),
        result.latencyMs,
        result.model,
        this.now(),
        id
      ]
    )
    this.onChange()
    return this.get(id)
  }

  /** Soft-delete: keep the row as a tombstone (deleted=1) so the deletion can sync. */
  delete(id: number): void {
    this.db.run('UPDATE transcripts SET deleted = 1, updated_at = ? WHERE id = ?', [this.now(), id])
    this.onChange()
  }

  clearUnsuccessful(): Transcript[] {
    const removed = this.query(
      `SELECT * FROM transcripts
       WHERE deleted = 0 AND status IN ('failed', 'empty')
       ORDER BY created_at DESC, id DESC`,
      []
    )
    if (!removed.length) return []
    this.db.run(
      `UPDATE transcripts SET deleted = 1, updated_at = ?
       WHERE deleted = 0 AND status IN ('failed', 'empty')`,
      [this.now()]
    )
    this.onChange()
    return removed
  }

  stats(now: number): Stats {
    const startToday = startOfDay(now)
    return {
      totalTranscripts: this.scalar(`SELECT COUNT(*) FROM transcripts WHERE status='ok' AND deleted=0`, []),
      totalWords: this.scalar(
        `SELECT COALESCE(SUM(word_count),0) FROM transcripts WHERE status='ok' AND deleted=0`,
        []
      ),
      todayCount: this.scalar(
        `SELECT COUNT(*) FROM transcripts WHERE status='ok' AND deleted=0 AND created_at >= ?`,
        [startToday]
      ),
      todayWords: this.scalar(
        `SELECT COALESCE(SUM(word_count),0) FROM transcripts WHERE status='ok' AND deleted=0 AND created_at >= ?`,
        [startToday]
      ),
      estSecondsSaved: estimatedSecondsSaved(
        this.scalar(`SELECT COALESCE(SUM(word_count),0) FROM transcripts WHERE status='ok' AND deleted=0`, [])
      ),
      streakDays: this.streak(now)
    }
  }

  private streak(now: number): number {
    const stmt = this.db.prepare(
      `SELECT created_at FROM transcripts WHERE status='ok' AND deleted=0 ORDER BY created_at DESC`
    )
    const days = new Set<number>()
    while (stmt.step()) days.add(startOfDay(stmt.get()[0] as number))
    stmt.free()
    let streak = 0
    let cursor = startOfDay(now)
    while (days.has(cursor)) {
      streak++
      cursor -= DAY_MS
    }
    return streak
  }

  private query(sql: string, params: SqlValue[]): Transcript[] {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const rows: Transcript[] = []
    while (stmt.step()) rows.push(toTranscript(stmt.getAsObject()))
    stmt.free()
    return rows
  }

  private filteredQuery(opts: HistoryQueryOpts, search?: string): Transcript[] {
    const clauses = ['deleted = 0']
    const params: SqlValue[] = []
    if (search) {
      const like = `%${search}%`
      clauses.push('(raw_text LIKE ? OR cleaned_text LIKE ?)')
      params.push(like, like)
    }
    if (opts.status) {
      clauses.push('status = ?')
      params.push(opts.status)
    }
    if (typeof opts.from === 'number' && Number.isFinite(opts.from)) {
      clauses.push('created_at >= ?')
      params.push(opts.from)
    }
    params.push(opts.limit, opts.offset)
    return this.query(
      `SELECT * FROM transcripts WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      params
    )
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

function toTranscript(o: Record<string, SqlValue>): Transcript {
  return {
    id: o.id as number,
    created_at: o.created_at as number,
    raw_text: o.raw_text as string,
    cleaned_text: (o.cleaned_text as string | null) ?? null,
    duration_ms: o.duration_ms as number,
    word_count: o.word_count as number,
    latency_ms: o.latency_ms as number,
    app_context: o.app_context as string,
    model: o.model as string,
    status: o.status as TranscriptStatus,
    audio_path: (o.audio_path as string | null) ?? null
  }
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
