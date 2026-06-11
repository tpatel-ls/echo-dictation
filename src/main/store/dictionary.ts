import type { Database, SqlValue } from 'sql.js'
import type { DictionaryEntry, DictionarySource } from '@shared/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dictionary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,
  misheard TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  times_applied INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dictionary_word ON dictionary(word COLLATE NOCASE);
`

/**
 * Personal vocabulary over the shared sql.js database (same file as history).
 * `word` is the canonical spelling; `misheard` is a JSON array of aliases that
 * should always be replaced by it. Adding an existing word merges aliases.
 */
export class DictionaryStore {
  constructor(
    private db: Database,
    private onChange: () => void = () => {}
  ) {
    this.db.run(SCHEMA)
  }

  list(): DictionaryEntry[] {
    return this.query('SELECT * FROM dictionary ORDER BY created_at DESC, id DESC', [])
  }

  get(id: number): DictionaryEntry | null {
    return this.query('SELECT * FROM dictionary WHERE id = ?', [id])[0] ?? null
  }

  add(word: string, misheard: string[], source: DictionarySource): DictionaryEntry {
    const w = word.trim().replace(/\s+/g, ' ')
    if (!w) throw new Error('A dictionary word is required')

    const existing = this.query('SELECT * FROM dictionary WHERE word = ? COLLATE NOCASE', [w])[0]
    if (existing) {
      const merged = normalizeAliases([...existing.misheard, ...misheard], existing.word)
      this.db.run('UPDATE dictionary SET misheard = ? WHERE id = ?', [JSON.stringify(merged), existing.id])
      this.onChange()
      return { ...existing, misheard: merged }
    }

    const entry = {
      word: w,
      misheard: normalizeAliases(misheard, w),
      source,
      created_at: Date.now(),
      times_applied: 0
    }
    this.db.run(
      'INSERT INTO dictionary (word, misheard, source, created_at, times_applied) VALUES (?,?,?,?,?)',
      [entry.word, JSON.stringify(entry.misheard), entry.source, entry.created_at, entry.times_applied]
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
    this.db.run('UPDATE dictionary SET word = ?, misheard = ? WHERE id = ?', [
      word,
      JSON.stringify(misheard),
      id
    ])
    this.onChange()
    return { ...cur, word, misheard }
  }

  delete(id: number): void {
    this.db.run('DELETE FROM dictionary WHERE id = ?', [id])
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
    for (const id of ids) {
      this.db.run('UPDATE dictionary SET times_applied = times_applied + 1 WHERE id = ?', [id])
    }
    this.onChange()
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
