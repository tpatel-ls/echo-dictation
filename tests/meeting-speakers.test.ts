import { describe, it, expect } from 'vitest'
import {
  DEFAULT_NAMING,
  cosine,
  liveSpeakers,
  nameSpeakers,
  renameSpeaker,
  type NamingOptions,
  type SpeakerEvidence,
  type VoiceprintCandidate
} from '@shared/meeting-speakers'
import type { MeetingSpeaker } from '@shared/meeting-types'

const DIM = 32
const OPTS: NamingOptions = { userName: 'Tanay', ...DEFAULT_NAMING }

function basis(i: number): number[] {
  const v = new Array(DIM).fill(0)
  v[i] = 1
  return v
}

// Speaker i's embedding is basis(i). An exemplar scoring exactly `c` against speaker i (and 0 against
// every other speaker) is c·basis(i) + √(1−c²)·basis(u) for a spare direction u ≥ 16 that no
// speaker uses (speakers use 0..15).
let spare = 0
function exemplarFor(speaker: number, c: number): { embedding: number[]; sourceApp: string } {
  const u = basis(16 + (spare++ % 16))
  const e = basis(speaker).map((x, k) => c * x + Math.sqrt(1 - c * c) * u[k])
  return { embedding: e, sourceApp: 'google-meet' }
}

function person(personId: number, name: string, scores: Array<[number, number]>): VoiceprintCandidate {
  return { personId, name, exemplars: scores.map(([s, c]) => exemplarFor(s, c)) }
}

function others(i: number, seconds: number, firstStartMs = i * 1000): SpeakerEvidence {
  return { key: `others:SPEAKER_0${i}`, channel: 'others', seconds, embedding: basis(i), firstStartMs }
}

const ME: SpeakerEvidence = { key: 'me', channel: 'mic', seconds: 300, embedding: basis(9), firstStartMs: 500 }

function byKey(speakers: MeetingSpeaker[]): Record<string, MeetingSpeaker> {
  return Object.fromEntries(speakers.map((s) => [s.key, s]))
}

describe('cosine', () => {
  it('is the cosine of the angle between vectors', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 3])).toBeCloseTo(0)
    expect(cosine([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2)
    expect(cosine([0, 0], [1, 0])).toBe(0)
  })
})

describe('DEFAULT_NAMING', () => {
  it('uses the spec thresholds', () => {
    expect(DEFAULT_NAMING).toEqual({ accept: 0.7, suggest: 0.55, margin: 0.1, minMatchSeconds: 5, minHintSeconds: 10 })
  })
})

describe('nameSpeakers: the local user', () => {
  it('labels me with the user name, or You', () => {
    expect(nameSpeakers([ME], [], [], 'teams', OPTS)).toEqual([
      { key: 'me', label: 'Tanay', source: 'self', personId: null, suggestion: null, score: null, seconds: 300 }
    ])
    expect(nameSpeakers([ME], [], [], 'teams', { ...OPTS, userName: '' })[0].label).toBe('You')
  })

  it('never matches me against voiceprints', () => {
    const people = [person(1, 'Blake', [[9, 0.99]])]
    expect(nameSpeakers([ME], people, [], 'teams', OPTS)[0]).toMatchObject({ label: 'Tanay', source: 'self', personId: null })
  })
})

describe('nameSpeakers: voiceprints', () => {
  it('auto-names above the accept threshold with a clear margin', () => {
    const people = [person(1, 'Blake', [[0, 0.82]]), person(2, 'Alice', [[0, 0.6]])]
    const [s] = nameSpeakers([others(0, 60)], people, [], 'google-meet', OPTS)
    expect(s).toEqual({
      key: 'others:SPEAKER_00',
      label: 'Blake',
      source: 'voiceprint',
      personId: 1,
      suggestion: null,
      score: expect.closeTo(0.82, 5),
      seconds: 60
    })
  })

  it('scores a person by their best exemplar', () => {
    const people = [person(1, 'Blake', [[0, 0.4], [0, 0.8], [0, 0.5]])]
    const [s] = nameSpeakers([others(0, 60)], people, [], 'google-meet', OPTS)
    expect(s).toMatchObject({ label: 'Blake', source: 'voiceprint', score: expect.closeTo(0.8, 5) })
  })

  it('only suggests when the runner-up is within the margin', () => {
    const people = [person(1, 'Blake', [[0, 0.85]]), person(2, 'Alice', [[0, 0.78]])]
    const [s] = nameSpeakers([others(0, 60)], people, [], 'google-meet', OPTS)
    expect(s).toMatchObject({
      label: 'Speaker 1',
      source: 'unknown',
      personId: null,
      suggestion: 'Blake',
      score: expect.closeTo(0.85, 5)
    })
  })

  it('only suggests for a speaker with under 5 s of speech', () => {
    const [s] = nameSpeakers([others(0, 4)], [person(1, 'Blake', [[0, 0.95]])], [], 'google-meet', OPTS)
    expect(s).toMatchObject({ label: 'Speaker 1', source: 'unknown', suggestion: 'Blake' })
  })

  it('suggests in the 0.55–0.70 band and ignores scores below it', () => {
    const suggest = nameSpeakers([others(0, 60)], [person(1, 'Blake', [[0, 0.6]])], [], 'google-meet', OPTS)[0]
    expect(suggest).toMatchObject({ source: 'unknown', suggestion: 'Blake', score: expect.closeTo(0.6, 5) })
    const none = nameSpeakers([others(0, 60)], [person(1, 'Blake', [[0, 0.5]])], [], 'google-meet', OPTS)[0]
    expect(none).toMatchObject({ source: 'unknown', suggestion: null, score: null })
  })

  it('assigns a person to at most one speaker, the best-scoring one', () => {
    const people = [person(1, 'Blake', [[0, 0.8], [1, 0.9]])]
    const out = byKey(nameSpeakers([others(0, 60), others(1, 60)], people, [], 'google-meet', OPTS))
    expect(out['others:SPEAKER_01']).toMatchObject({ label: 'Blake', source: 'voiceprint', personId: 1 })
    expect(out['others:SPEAKER_00']).toMatchObject({ label: 'Speaker 1', source: 'unknown', personId: null })
    // Blake is taken, so the other speaker is not offered him either.
    expect(out['others:SPEAKER_00'].suggestion).toBeNull()
  })

  it('lets the runner-up speaker take the next person', () => {
    const people = [person(1, 'Blake', [[0, 0.8], [1, 0.9]]), person(2, 'Alice', [[0, 0.75]])]
    const out = byKey(nameSpeakers([others(0, 60), others(1, 60)], people, [], 'google-meet', OPTS))
    expect(out['others:SPEAKER_01'].label).toBe('Blake')
    // Alice's 0.75 is within the margin of Blake's 0.8 for this speaker: a suggestion only.
    expect(out['others:SPEAKER_00']).toMatchObject({ source: 'unknown', suggestion: 'Alice' })
  })

  it('skips exemplars of another dimension', () => {
    const odd: VoiceprintCandidate = { personId: 1, name: 'Blake', exemplars: [{ embedding: [1, 0, 0], sourceApp: 'teams' }] }
    const [s] = nameSpeakers([others(0, 60)], [odd], [], 'google-meet', OPTS)
    expect(s).toMatchObject({ source: 'unknown', suggestion: null, score: null })
  })

  it('ignores speakers without an embedding', () => {
    const noEmbedding = { ...others(0, 60), embedding: null }
    const [s] = nameSpeakers([noEmbedding], [person(1, 'Blake', [[0, 0.9]])], [], 'google-meet', OPTS)
    expect(s.source).toBe('unknown')
  })
})

describe('nameSpeakers: window-title hints', () => {
  it('names the single remote speaker after the single hint', () => {
    const out = nameSpeakers([ME, others(0, 60)], [], ['Blake Whitmore'], 'teams', OPTS)
    expect(out[1]).toEqual({
      key: 'others:SPEAKER_00',
      label: 'Blake Whitmore',
      source: 'hint',
      personId: null,
      suggestion: null,
      score: null,
      seconds: 60
    })
  })

  it('counts hints case-insensitively and ignores brief remote voices', () => {
    const out = byKey(nameSpeakers([others(0, 60), others(1, 4)], [], ['Blake', 'blake '], 'slack', OPTS))
    expect(out['others:SPEAKER_00']).toMatchObject({ label: 'Blake', source: 'hint' })
    expect(out['others:SPEAKER_01']).toMatchObject({ label: 'Speaker 1', source: 'unknown' })
  })

  it('does not apply with two hints, two substantial remote speakers, or no hint', () => {
    expect(nameSpeakers([others(0, 60)], [], ['Blake', 'Alice'], 'slack', OPTS)[0].source).toBe('unknown')
    expect(nameSpeakers([others(0, 60), others(1, 30)], [], ['Blake'], 'slack', OPTS).map((s) => s.source)).toEqual([
      'unknown',
      'unknown'
    ])
    expect(nameSpeakers([others(0, 60)], [], [], 'slack', OPTS)[0].source).toBe('unknown')
    expect(nameSpeakers([others(0, 9)], [], ['Blake'], 'slack', OPTS)[0].source).toBe('unknown')
  })

  it('never applies to a speaker in the room', () => {
    const room: SpeakerEvidence = { key: 'mic:SPEAKER_01', channel: 'mic', seconds: 60, embedding: null, firstStartMs: 0 }
    expect(nameSpeakers([room], [], ['Blake'], 'teams', OPTS)[0].source).toBe('unknown')
  })

  it('yields to a voiceprint auto-match on the hinted speaker', () => {
    const [s] = nameSpeakers([others(0, 60)], [person(1, 'Alice', [[0, 0.9]])], ['Blake'], 'teams', OPTS)
    expect(s).toMatchObject({ label: 'Alice', source: 'voiceprint' })
  })

  it('is not used when another speaker was auto-named to that name', () => {
    const room: SpeakerEvidence = { key: 'mic:SPEAKER_01', channel: 'mic', seconds: 60, embedding: basis(1), firstStartMs: 0 }
    const out = byKey(nameSpeakers([room, others(0, 60)], [person(1, 'blake', [[1, 0.9]])], ['Blake'], 'teams', OPTS))
    expect(out['mic:SPEAKER_01']).toMatchObject({ label: 'blake', source: 'voiceprint' })
    expect(out['others:SPEAKER_00']).toMatchObject({ label: 'Speaker 1', source: 'unknown' })
  })

  it('uses the hint but keeps a voiceprint suggestion for someone else', () => {
    const [s] = nameSpeakers([others(0, 60)], [person(1, 'Alice', [[0, 0.6]])], ['Blake'], 'teams', OPTS)
    expect(s).toMatchObject({ label: 'Blake', source: 'hint', suggestion: 'Alice', score: expect.closeTo(0.6, 5) })
  })
})

describe('nameSpeakers: unknown speakers and order', () => {
  it('numbers only unnamed speakers, in order of first appearance, after me', () => {
    const people = [person(1, 'Blake', [[1, 0.9]])]
    const out = nameSpeakers(
      [others(2, 30, 9000), others(1, 30, 2000), ME, others(0, 30, 5000), others(3, 30, 1000)],
      people,
      [],
      'zoom',
      OPTS
    )
    expect(out.map((s) => [s.key, s.label])).toEqual([
      ['me', 'Tanay'],
      ['others:SPEAKER_03', 'Speaker 1'],
      ['others:SPEAKER_01', 'Blake'],
      ['others:SPEAKER_00', 'Speaker 2'],
      ['others:SPEAKER_02', 'Speaker 3']
    ])
  })
})

describe('renameSpeaker', () => {
  const base = (): MeetingSpeaker[] =>
    nameSpeakers(
      [ME, others(0, 60, 1000), others(1, 60, 2000), others(2, 60, 3000)],
      [person(7, 'Blake', [[1, 0.9]]), person(8, 'Alice', [[2, 0.6]])],
      [],
      'teams',
      OPTS
    )

  it('names a speaker as the user chose and clears its suggestion', () => {
    const out = byKey(renameSpeaker(base(), 'others:SPEAKER_02', 'Alice', 8))
    expect(out['others:SPEAKER_02']).toMatchObject({ label: 'Alice', source: 'user', personId: 8, suggestion: null })
  })

  it('renumbers the remaining unknown speakers', () => {
    const out = renameSpeaker(base(), 'others:SPEAKER_00', 'Carol', null)
    expect(out.map((s) => s.label)).toEqual(['Tanay', 'Carol', 'Blake', 'Speaker 1'])
  })

  it('reverts another automatic speaker with the same name to unknown', () => {
    const out = renameSpeaker(base(), 'others:SPEAKER_00', 'blake', 7)
    expect(out.map((s) => [s.label, s.source])).toEqual([
      ['Tanay', 'self'],
      ['blake', 'user'],
      ['Speaker 1', 'unknown'],
      ['Speaker 2', 'unknown']
    ])
    expect(out[2].personId).toBeNull()
  })

  it('does not revert a name the user gave or the user themself', () => {
    const once = renameSpeaker(base(), 'others:SPEAKER_00', 'Dana', null)
    const twice = renameSpeaker(once, 'others:SPEAKER_02', 'Dana', null)
    expect(twice.map((s) => [s.label, s.source])).toEqual([
      ['Tanay', 'self'],
      ['Dana', 'user'],
      ['Blake', 'voiceprint'],
      ['Dana', 'user']
    ])
    expect(renameSpeaker(base(), 'others:SPEAKER_00', 'Tanay', null)[0]).toMatchObject({ label: 'Tanay', source: 'self' })
  })

  it('leaves the list alone for an unknown key', () => {
    expect(renameSpeaker(base(), 'others:SPEAKER_09', 'X', null)).toEqual(base())
  })
})

describe('liveSpeakers', () => {
  it('shows me and the single hinted remote party', () => {
    expect(liveSpeakers('Tanay', ['Blake', 'BLAKE'])).toEqual([
      { key: 'me', label: 'Tanay', source: 'self', personId: null, suggestion: null, score: null, seconds: 0 },
      { key: 'others', label: 'Blake', source: 'hint', personId: null, suggestion: null, score: null, seconds: 0 }
    ])
  })

  it('falls back to You and Others', () => {
    expect(liveSpeakers('', ['Blake', 'Alice']).map((s) => [s.label, s.source])).toEqual([
      ['You', 'self'],
      ['Others', 'unknown']
    ])
    expect(liveSpeakers('Tanay', [])[1].label).toBe('Others')
  })
})
