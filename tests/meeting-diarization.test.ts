import { describe, it, expect } from 'vitest'
import { mergeSpeakers, DEFAULT_MERGE } from '@shared/meeting-diarization'
import type { DiarizationResult, DiarizedSpeaker, DiarizedTurn } from '@shared/meeting-types'

/** A unit vector at `angle` (radians) in the first two dimensions: cosine between two is cos(Δangle). */
function voice(angle: number): number[] {
  const v = new Array(8).fill(0)
  v[0] = Math.cos(angle)
  v[1] = Math.sin(angle)
  return v
}
const withCosine = (c: number): number[] => voice(Math.acos(c))

function result(speakers: Array<[string, number, number[] | null]>, turns: DiarizedTurn[]): DiarizationResult {
  return {
    duration: 1400,
    model: 'pyannote/speaker-diarization-community-1',
    embeddingModel: 'wespeaker',
    embeddingDim: 8,
    speakers: speakers.map(([id, speechSeconds, embedding]): DiarizedSpeaker => ({ id, speechSeconds, turns: 1, embedding })),
    segments: turns
  }
}
const turn = (start: number, end: number, speaker: string): DiarizedTurn => ({ start, end, speaker })

describe('mergeSpeakers', () => {
  it('uses the calibrated thresholds', () => {
    expect(DEFAULT_MERGE).toEqual({ minorSeconds: 20, minorShare: 0.1, minorCosine: 0.25, majorCosine: 0.75 })
  })

  it('folds a backchannel-only cluster into the one real speaker (the interview: cosine 0.298)', () => {
    const r = result(
      [
        ['SPEAKER_00', 550.5, voice(0)],
        ['SPEAKER_01', 19.3, withCosine(0.298)]
      ],
      [turn(10, 40, 'SPEAKER_00'), turn(41, 41.8, 'SPEAKER_01'), turn(43, 90, 'SPEAKER_00')]
    )
    const { result: merged, merges } = mergeSpeakers(r)
    expect(merges).toEqual([{ from: 'SPEAKER_01', into: 'SPEAKER_00', reason: 'minor', cosine: 0.298 }])
    expect(merged.speakers).toEqual([{ id: 'SPEAKER_00', speechSeconds: 569.8, turns: 2, embedding: voice(0) }])
    expect(merged.segments.map((t) => t.speaker)).toEqual(['SPEAKER_00', 'SPEAKER_00', 'SPEAKER_00'])
  })

  it('keeps a brief speaker whose voice is clearly different', () => {
    const r = result(
      [
        ['SPEAKER_00', 550, voice(0)],
        ['SPEAKER_01', 15, withCosine(0.18)]
      ],
      [turn(0, 10, 'SPEAKER_00'), turn(11, 20, 'SPEAKER_01')]
    )
    expect(mergeSpeakers(r).merges).toEqual([])
  })

  it('folds a speaker too brief for a voice embedding into the only major speaker, but not when there are two', () => {
    const one = result(
      [
        ['SPEAKER_00', 300, voice(0)],
        ['SPEAKER_01', 1.2, null]
      ],
      [turn(0, 10, 'SPEAKER_00'), turn(11, 12.2, 'SPEAKER_01')]
    )
    expect(mergeSpeakers(one).merges).toEqual([{ from: 'SPEAKER_01', into: 'SPEAKER_00', reason: 'minor-no-embedding', cosine: null }])
    const two = result(
      [
        ['SPEAKER_00', 300, voice(0)],
        ['SPEAKER_01', 280, voice(1.5)],
        ['SPEAKER_02', 1.2, null]
      ],
      [turn(0, 10, 'SPEAKER_00'), turn(11, 20, 'SPEAKER_01'), turn(21, 22, 'SPEAKER_02')]
    )
    expect(mergeSpeakers(two).merges).toEqual([])
  })

  it('merges two major clusters of the same voice, and keeps two different ones', () => {
    const same = result(
      [
        ['SPEAKER_00', 300, voice(0)],
        ['SPEAKER_01', 200, withCosine(0.8)]
      ],
      [turn(0, 10, 'SPEAKER_00'), turn(11, 20, 'SPEAKER_01')]
    )
    expect(mergeSpeakers(same).merges).toEqual([{ from: 'SPEAKER_01', into: 'SPEAKER_00', reason: 'same-voice', cosine: 0.8 }])
    const different = result(
      [
        ['SPEAKER_00', 300, voice(0)],
        ['SPEAKER_01', 200, withCosine(0.5)]
      ],
      [turn(0, 10, 'SPEAKER_00'), turn(11, 20, 'SPEAKER_01')]
    )
    expect(mergeSpeakers(different).merges).toEqual([])
  })

  it('keeps two similar-sounding major speakers apart when they talk at the same time', () => {
    // One person cannot overlap themself: a second of simultaneous speech means two people.
    const overlapping = result(
      [
        ['SPEAKER_00', 300, voice(0)],
        ['SPEAKER_01', 200, withCosine(0.8)]
      ],
      [turn(0, 10, 'SPEAKER_00'), turn(8.5, 20, 'SPEAKER_01'), turn(30, 40, 'SPEAKER_00')]
    )
    expect(mergeSpeakers(overlapping).merges).toEqual([])
    // Boundary jitter (a few hundred ms) is not talking at the same time.
    const jitter = result(
      [
        ['SPEAKER_00', 300, voice(0)],
        ['SPEAKER_01', 200, withCosine(0.8)]
      ],
      [turn(0, 10, 'SPEAKER_00'), turn(9.7, 20, 'SPEAKER_01'), turn(19.8, 30, 'SPEAKER_00')]
    )
    expect(mergeSpeakers(jitter).merges.map((m) => m.reason)).toEqual(['same-voice'])
  })

  it('merges everyone into the main voice when the calendar says one person is on this channel', () => {
    const r = result(
      [
        ['SPEAKER_00', 300, voice(0)],
        ['SPEAKER_01', 90, withCosine(0.1)],
        ['SPEAKER_02', 2, null]
      ],
      [turn(0, 10, 'SPEAKER_00'), turn(11, 20, 'SPEAKER_01'), turn(21, 22, 'SPEAKER_02')]
    )
    const { result: merged, merges } = mergeSpeakers(r, { expectedSpeakers: 1 })
    expect(merges.map((m) => [m.from, m.into, m.reason])).toEqual([
      ['SPEAKER_01', 'SPEAKER_00', 'single-attendee'],
      ['SPEAKER_02', 'SPEAKER_00', 'single-attendee']
    ])
    expect(merged.speakers.map((s) => s.id)).toEqual(['SPEAKER_00'])
  })

  it('leaves a single-speaker result alone', () => {
    const r = result([['SPEAKER_00', 3, null]], [turn(0, 3, 'SPEAKER_00')])
    expect(mergeSpeakers(r)).toEqual({ result: r, merges: [] })
  })
})
