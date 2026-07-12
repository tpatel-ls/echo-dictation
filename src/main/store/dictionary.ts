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
    const ts = this.now()

    // Only an active (non-deleted) entry merges; a tombstone with this word is ignored, so
    // a deleted word can be re-added fresh (the partial unique index permits the coexistence).
    const existing = this.query('SELECT * FROM dictionary WHERE word = ? COLLATE NOCASE AND deleted = 0', [w])[0]
    if (existing) {
      const merged = this.claimAliases(
        existing.word,
        normalizeAliases([...existing.misheard, ...misheard], existing.word),
        existing.id,
        ts
      )
      this.db.run('UPDATE dictionary SET misheard = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(merged),
        ts,
        existing.id
      ])
      this.onChange()
      return { ...existing, misheard: merged }
    }

    const entry = {
      word: w,
      misheard: this.claimAliases(w, normalizeAliases(misheard, w), undefined, ts),
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
    const ts = this.now()
    const misheard = this.claimAliases(
      word,
      normalizeAliases(patch.misheard ?? cur.misheard, word),
      id,
      ts
    )
    this.db.run('UPDATE dictionary SET word = ?, misheard = ?, updated_at = ? WHERE id = ?', [
      word,
      JSON.stringify(misheard),
      ts,
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

  /** A spoken alias must map to one canonical entry. The latest explicit assignment wins,
   * while canonical words remain protected from being used as another entry's alias. */
  private claimAliases(word: string, aliases: string[], ownerId: number | undefined, ts: number): string[] {
    const active = this.list()
    const canonicalWords = new Set(
      active
        .filter((entry) => entry.id !== ownerId)
        .map((entry) => entry.word.toLowerCase())
    )
    const allowed = aliases.filter((alias) => !canonicalWords.has(alias.toLowerCase()))
    const claimed = new Set([word, ...allowed].map((value) => value.toLowerCase()))

    for (const entry of active) {
      if (entry.id === ownerId) continue
      const remaining = entry.misheard.filter((alias) => !claimed.has(alias.toLowerCase()))
      if (remaining.length === entry.misheard.length) continue
      this.db.run('UPDATE dictionary SET misheard = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(remaining),
        ts,
        entry.id
      ])
    }
    return allowed
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
    if (!a || key === word.toLowerCase() || seen.has(key)) continue
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
