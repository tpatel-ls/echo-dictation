import type { Database, SqlValue } from 'sql.js'
import type { Person } from '@shared/meeting-types'
import { monotonicClock } from './clock'

// Remembered voices: people the user has named, each with up to MAX_EXEMPLARS speaker embeddings.
// Voiceprints are biometric data, so they live only in this local database and are never synced
// or sent anywhere. Embeddings are stored unit-length as little-endian float32 BLOBs.

export interface NewExemplar {
  embedding: number[]
  model: string
  seconds: number
  sourceApp: string
}

/**
 * One person's exemplars for a single embedding model. Structurally identical to
 * `VoiceprintCandidate` in src/shared/meeting-speakers.ts, which the naming logic consumes.
 */
export interface StoredVoiceprints {
  personId: number
  name: string
  exemplars: Array<{ embedding: number[]; sourceApp: string }>
}

export const MAX_EXEMPLARS = 20

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS voiceprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  embedding BLOB NOT NULL,
  seconds REAL NOT NULL,
  source_app TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voiceprints_person ON voiceprints(person_id, created_at);
`

export class VoiceprintStore {
  constructor(
    private db: Database,
    private onChange: () => void = () => {},
    private now: () => number = monotonicClock()
  ) {
    this.db.run(SCHEMA)
  }

  people(): Person[] {
    const stmt = this.db.prepare(
      `SELECT p.id, p.name, COUNT(v.id) AS exemplars, COALESCE(SUM(v.seconds), 0) AS seconds
       FROM people p LEFT JOIN voiceprints v ON v.person_id = p.id
       GROUP BY p.id ORDER BY p.name COLLATE NOCASE, p.id`
    )
    const rows: Person[] = []
    while (stmt.step()) {
      const o = stmt.getAsObject()
      rows.push({
        id: o.id as number,
        name: o.name as string,
        exemplars: o.exemplars as number,
        seconds: o.seconds as number
      })
    }
    stmt.free()
    return rows
  }

  /** Match on the trimmed name, ignoring case (including non-ASCII letters, which SQLite's NOCASE does not fold). */
  findByName(name: string): { id: number; name: string } | null {
    const wanted = name.trim().toLocaleLowerCase()
    if (!wanted) return null
    return this.allPeople().find((p) => p.name.toLocaleLowerCase() === wanted) ?? null
  }

  ensurePerson(name: string): { id: number; name: string } {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('A person needs a name')
    const existing = this.findByName(trimmed)
    if (existing) return existing
    this.db.run('INSERT INTO people (name, created_at) VALUES (?, ?)', [trimmed, this.now()])
    const id = this.scalar('SELECT last_insert_rowid()', [])
    this.onChange()
    return { id, name: trimmed }
  }

  /** Enrol one embedding (unit-normalised on the way in), evicting the person's oldest beyond the cap. */
  addExemplar(personId: number, ex: NewExemplar): void {
    if (!this.scalar('SELECT COUNT(*) FROM people WHERE id = ?', [personId])) {
      throw new Error(`No person with id ${personId}`)
    }
    const blob = encodeEmbedding(normalise(ex.embedding))
    this.db.run(
      `INSERT INTO voiceprints (person_id, model, embedding, seconds, source_app, created_at)
       VALUES (?,?,?,?,?,?)`,
      [personId, ex.model, blob, ex.seconds, ex.sourceApp, this.now()]
    )
    this.db.run(
      `DELETE FROM voiceprints WHERE person_id = ? AND id NOT IN (
         SELECT id FROM voiceprints WHERE person_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
       )`,
      [personId, personId, MAX_EXEMPLARS]
    )
    this.onChange()
  }

  /** Everyone with at least one exemplar from `model`; embeddings from other models are never compared. */
  candidates(model: string): StoredVoiceprints[] {
    const stmt = this.db.prepare(
      `SELECT p.id AS person_id, p.name, v.embedding, v.source_app
       FROM voiceprints v JOIN people p ON p.id = v.person_id
       WHERE v.model = ?
       ORDER BY p.name COLLATE NOCASE, p.id, v.created_at, v.id`
    )
    stmt.bind([model])
    const byPerson = new Map<number, StoredVoiceprints>()
    while (stmt.step()) {
      const o = stmt.getAsObject()
      const personId = o.person_id as number
      let entry = byPerson.get(personId)
      if (!entry) {
        entry = { personId, name: o.name as string, exemplars: [] }
        byPerson.set(personId, entry)
      }
      entry.exemplars.push({ embedding: decodeEmbedding(o.embedding as Uint8Array), sourceApp: o.source_app as string })
    }
    stmt.free()
    return [...byPerson.values()]
  }

  /** Delete a person and every exemplar of their voice. */
  forget(personId: number): void {
    this.db.run('DELETE FROM voiceprints WHERE person_id = ?', [personId])
    this.db.run('DELETE FROM people WHERE id = ?', [personId])
    this.onChange()
  }

  private allPeople(): Array<{ id: number; name: string }> {
    const stmt = this.db.prepare('SELECT id, name FROM people ORDER BY id')
    const rows: Array<{ id: number; name: string }> = []
    while (stmt.step()) {
      const o = stmt.getAsObject()
      rows.push({ id: o.id as number, name: o.name as string })
    }
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

function normalise(embedding: number[]): number[] {
  if (!embedding.length || !embedding.every(Number.isFinite)) throw new Error('Invalid voiceprint embedding')
  const length = Math.sqrt(embedding.reduce((sum, x) => sum + x * x, 0))
  if (!(length > 0)) throw new Error('Invalid voiceprint embedding')
  return embedding.map((x) => x / length)
}

function encodeEmbedding(embedding: number[]): Uint8Array {
  const bytes = new Uint8Array(embedding.length * 4)
  const view = new DataView(bytes.buffer)
  embedding.forEach((x, i) => view.setFloat32(i * 4, x, true))
  return bytes
}

function decodeEmbedding(blob: Uint8Array): number[] {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  return Array.from({ length: Math.floor(blob.byteLength / 4) }, (_, i) => view.getFloat32(i * 4, true))
}
