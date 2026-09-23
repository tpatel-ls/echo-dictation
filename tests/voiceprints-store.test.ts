import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'node:path'
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js'
import { VoiceprintStore, type NewExemplar } from '../src/main/store/voiceprints'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})

function setup(onChange?: () => void): { db: Database; store: VoiceprintStore } {
  const db = new SQL.Database()
  let t = 1_000
  return { db, store: new VoiceprintStore(db, onChange, () => t++) }
}

function exemplar(overrides: Partial<NewExemplar> = {}): NewExemplar {
  return { embedding: [3, 4], model: 'wespeaker-r34', seconds: 12, sourceApp: 'google-meet', ...overrides }
}

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((a, x) => a + x * x, 0))
}

describe('VoiceprintStore', () => {
  it('creates people once, matching names trimmed and case-insensitively', () => {
    const onChange = vi.fn()
    const { store } = setup(onChange)
    const blake = store.ensurePerson('  Blake Whitmore ')
    expect(blake).toEqual({ id: blake.id, name: 'Blake Whitmore' })
    expect(store.ensurePerson('blake whitmore')).toEqual(blake)
    expect(store.findByName(' BLAKE WHITMORE')).toEqual(blake)
    expect(store.findByName('Blake')).toBeNull()
    expect(store.findByName('   ')).toBeNull()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(() => store.ensurePerson('  ')).toThrow()
  })

  it('stores embeddings as unit-length float32 and reads them back', () => {
    const { db, store } = setup()
    const p = store.ensurePerson('Priya')
    store.addExemplar(p.id, exemplar({ embedding: [3, 4, 0] }))
    const [candidate] = store.candidates('wespeaker-r34')
    expect(candidate.personId).toBe(p.id)
    expect(candidate.name).toBe('Priya')
    expect(candidate.exemplars).toHaveLength(1)
    const e = candidate.exemplars[0]
    expect(e.sourceApp).toBe('google-meet')
    expect(e.embedding[0]).toBeCloseTo(0.6, 6)
    expect(e.embedding[1]).toBeCloseTo(0.8, 6)
    expect(e.embedding[2]).toBe(0)
    expect(norm(e.embedding)).toBeCloseTo(1, 6)

    // The BLOB is 4 bytes per dimension, little-endian float32.
    const stmt = db.prepare('SELECT embedding FROM voiceprints')
    stmt.step()
    const blob = stmt.get()[0] as Uint8Array
    stmt.free()
    expect(blob.byteLength).toBe(12)
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
    expect(view.getFloat32(0, true)).toBeCloseTo(0.6, 6)
    expect(view.getFloat32(4, true)).toBeCloseTo(0.8, 6)
  })

  it('round-trips a 256-d embedding within float32 precision', () => {
    const { store } = setup()
    const p = store.ensurePerson('Marco')
    const raw = Array.from({ length: 256 }, (_, i) => Math.sin(i + 1))
    store.addExemplar(p.id, exemplar({ embedding: raw }))
    const got = store.candidates('wespeaker-r34')[0].exemplars[0].embedding
    const n = norm(raw)
    expect(got).toHaveLength(256)
    got.forEach((x, i) => expect(x).toBeCloseTo(raw[i] / n, 6))
  })

  it('rejects embeddings that cannot be normalised', () => {
    const { store } = setup()
    const p = store.ensurePerson('Zero')
    expect(() => store.addExemplar(p.id, exemplar({ embedding: [0, 0] }))).toThrow()
    expect(() => store.addExemplar(p.id, exemplar({ embedding: [] }))).toThrow()
    expect(() => store.addExemplar(p.id, exemplar({ embedding: [1, Number.NaN] }))).toThrow()
    expect(() => store.addExemplar(999, exemplar())).toThrow()
    expect(store.people()[0].exemplars).toBe(0)
  })

  it('keeps at most 20 exemplars per person, evicting the oldest', () => {
    const { store } = setup()
    const a = store.ensurePerson('A')
    const b = store.ensurePerson('B')
    store.addExemplar(b.id, exemplar({ seconds: 99 }))
    for (let i = 0; i < 25; i++) store.addExemplar(a.id, exemplar({ seconds: i, embedding: [1, i] }))
    const people = store.people()
    expect(people.find((p) => p.id === a.id)?.exemplars).toBe(20)
    expect(people.find((p) => p.id === a.id)?.seconds).toBe(Array.from({ length: 20 }, (_, i) => i + 5).reduce((x, y) => x + y))
    expect(people.find((p) => p.id === b.id)?.exemplars).toBe(1)
    // The survivors are the newest 20 (i = 5..24); i = 0 was [1, 0], which never survives.
    const kept = store.candidates('wespeaker-r34').find((c) => c.personId === a.id)!.exemplars
    expect(kept).toHaveLength(20)
    expect(kept.some((e) => e.embedding[1] === 0)).toBe(false)
  })

  it('lists people in name order with exemplar counts and seconds', () => {
    const { store } = setup()
    const z = store.ensurePerson('zoe')
    const a = store.ensurePerson('Aaron')
    store.ensurePerson('Mia')
    store.addExemplar(z.id, exemplar({ seconds: 10.5 }))
    store.addExemplar(z.id, exemplar({ seconds: 4.5 }))
    store.addExemplar(a.id, exemplar({ seconds: 30 }))
    expect(store.people()).toEqual([
      { id: a.id, name: 'Aaron', exemplars: 1, seconds: 30 },
      { id: expect.any(Number), name: 'Mia', exemplars: 0, seconds: 0 },
      { id: z.id, name: 'zoe', exemplars: 2, seconds: 15 }
    ])
  })

  it('offers only exemplars from the requested embedding model', () => {
    const { store } = setup()
    const a = store.ensurePerson('A')
    const b = store.ensurePerson('B')
    store.addExemplar(a.id, exemplar({ model: 'wespeaker-r34', sourceApp: 'teams' }))
    store.addExemplar(a.id, exemplar({ model: 'titanet' }))
    store.addExemplar(b.id, exemplar({ model: 'titanet' }))
    const r34 = store.candidates('wespeaker-r34')
    expect(r34.map((c) => [c.name, c.exemplars.length, c.exemplars[0].sourceApp])).toEqual([['A', 1, 'teams']])
    expect(store.candidates('titanet').map((c) => c.name)).toEqual(['A', 'B'])
    expect(store.candidates('other')).toEqual([])
  })

  it('forgets a person and every exemplar', () => {
    const onChange = vi.fn()
    const { db, store } = setup(onChange)
    const a = store.ensurePerson('A')
    const b = store.ensurePerson('B')
    store.addExemplar(a.id, exemplar())
    store.addExemplar(b.id, exemplar())
    onChange.mockClear()
    store.forget(a.id)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(store.findByName('A')).toBeNull()
    expect(store.people().map((p) => p.name)).toEqual(['B'])
    const stmt = db.prepare('SELECT COUNT(*) FROM voiceprints WHERE person_id = ?')
    stmt.bind([a.id])
    stmt.step()
    expect(stmt.get()[0]).toBe(0)
    stmt.free()
  })
})
