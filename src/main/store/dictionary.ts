import type { Database, SqlValue } from 'sql.js'
import type { DictionaryEntry, DictionarySource } from '@shared/types'
import { ensureSyncColumns } from './migrate'
import { monotonicClock } from './clock'
import { randomUUID } from 'node:crypto'

// No unique word index: word-uniqueness is enforced at the app level (add() merges an
// existing active word). A DB-level unique constraint would wedge cross-device sync when
// two devices independently add the same word (each with its own uuid), so the constructor
// drops any legacy one and tolerates the rare cross-device duplicate.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS dictionary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,
  misheard TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  times_applied INTEGER NOT NULL DEFAULT 0
);
`

/**
 * Personal vocabulary over the shared sql.js database (same file as history).
 * `word` is the canonical spelling; `misheard` is a JSON array of aliases that
 * should always be replaced by it. Adding an existing word merges aliases.
 */
export class DictionaryStore {
  constructor(
    private db: Database,
    private onChange: () => void = () => {},
    private now: () => number = monotonicClock()
  ) {
    this.db.run(SCHEMA)
    ensureSyncColumns(this.db, 'dictionary')
    this.dropLegacyWordIndex()
  }

  list(): DictionaryEntry[] {
    return this.query('SELECT * FROM dictionary WHERE deleted = 0 ORDER BY created_at DESC, id DESC', [])
  }

  get(id: number): DictionaryEntry | null {
    return this.query('SELECT * FROM dictionary WHERE id = ? AND deleted = 0', [id])[0] ?? null
  }

  add(word: string, misheard: string[], source: DictionarySource): DictionaryEntry {
    const w = word.trim().replace(/\s+/g, ' ')
    if (!w) throw new Error('A dictionary word is required')

    // Only an active (non-deleted) entry merges; a tombstone with this word is ignored, so
    // a deleted word can be re-added fresh (the partial unique index permits the coexistence).
    const existing = this.query('SELECT * FROM dictionary WHERE word = ? COLLATE NOCASE AND deleted = 0', [w])[0]
    if (existing) {
      const merged = normalizeAliases([...existing.misheard, ...misheard], existing.word)
      this.db.run('UPDATE dictionary SET misheard = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(merged),
        this.now(),
        existing.id
      ])
      this.onChange()
      return { ...existing, misheard: merged }
    }

    const ts = this.now()
    const entry = {
      word: w,
      misheard: normalizeAliases(misheard, w),
      source,
      created_at: ts,
      times_applied: 0
    }
    this.db.run(
      'INSERT INTO dictionary (word, misheard, source, created_at, times_applied, uuid, updated_at, deleted) VALUES (?,?,?,?,?,?,?,0)',
      [entry.word, JSON.stringify(entry.misheard), entry.source, entry.created_at, entry.times_applied, randomUUID(), ts]
    )
    const id = this.scalar('SELECT last_insert_rowid()')
    this.onChange()
    return { id, ...entry }
  }

  update(id: number, patch: { word?: string; misheard?: string[] }): DictionaryEntry | null {
    const cur = this.get(id)
    if (!cur) return null
    const word = (patch.word ?? cur.word).trim().replace(/\s+/g, ' ')
    if (!word) throw new Error('A dictionary word is required')
    const misheard = normalizeAliases(patch.misheard ?? cur.misheard, word)
    this.db.run('UPDATE dictionary SET word = ?, misheard = ?, updated_at = ? WHERE id = ?', [
      word,
      JSON.stringify(misheard),
      this.now(),
      id
    ])
    this.onChange()
    return { ...cur, word, misheard }
  }

  /** Soft-delete: keep the row as a tombstone (deleted=1) so the deletion can sync. */
  delete(id: number): void {
    this.db.run('UPDATE dictionary SET deleted = 1, updated_at = ? WHERE id = ?', [this.now(), id])
    this.onChange()
  }

  /** Remove one alias (case-insensitive) — the undo path for a learned correction. */
  removeAlias(id: number, alias: string): DictionaryEntry | null {
    const cur = this.get(id)
    if (!cur) return null
    const target = alias.trim().toLowerCase()
    return this.update(id, { misheard: cur.misheard.filter((a) => a.toLowerCase() !== target) })
  }

  recordApplied(ids: number[]): void {
    if (!ids.length) return
    const ts = this.now()
    for (const id of ids) {
      // Guard deleted=0 so a stale id can never bump a tombstone back to "recently changed".
      this.db.run(
        'UPDATE dictionary SET times_applied = times_applied + 1, updated_at = ? WHERE id = ? AND deleted = 0',
        [ts, id]
      )
    }
    this.onChange()
  }

  /**
   * Drop the legacy unique word index. Word-uniqueness is enforced at the app level (add()
   * merges an existing active word); a DB-level unique constraint would wedge cross-device
   * sync when two devices independently add the same word, each with its own uuid.
   */
  private dropLegacyWordIndex(): void {
    this.db.run('DROP INDEX IF EXISTS idx_dictionary_word')
  }

  private query(sql: string, params: SqlValue[]): DictionaryEntry[] {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const rows: DictionaryEntry[] = []
    while (stmt.step()) rows.push(toEntry(stmt.getAsObject()))
    stmt.free()
    return rows
  }

  private scalar(sql: string): number {
    const stmt = this.db.prepare(sql)
    let v = 0
    if (stmt.step()) v = (stmt.get()[0] as number) ?? 0
    stmt.free()
    return v
  }
}

/** Trim, drop empties and exact duplicates of the word, dedupe case-insensitively. */
function normalizeAliases(aliases: string[], word: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of aliases) {
    const a = raw.trim().replace(/\s+/g, ' ')
    const key = a.toLowerCase()
    if (!a || a === word || seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}

function toEntry(o: Record<string, SqlValue>): DictionaryEntry {
  return {
    id: o.id as number,
    word: o.word as string,
    misheard: safeParse(o.misheard as string),
    source: o.source as DictionarySource,
    created_at: o.created_at as number,
    times_applied: o.times_applied as number
  }
}

function safeParse(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
