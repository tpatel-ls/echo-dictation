import { describe, expect, it } from 'vitest'
import { applyParticipantNames, applyConversationSuggestions, restoreConfirmedNames, retireUnverifiedNames } from '@shared/meeting-identity'
import { authoritativeParticipants } from '@shared/meet-controls'
import type { MeetingSpeaker } from '@shared/meeting-types'

const unknown = (key = 'others:A'): MeetingSpeaker => ({ key, label: 'Speaker 1', source: 'unknown',
  personId: null, suggestion: null, score: null, seconds: 30 })

describe('speaker identity evidence', () => {
  it('retires old inferred names before they can be reused by a failed reprocess', () => {
    const old = [
      { ...unknown('others:A'), label: 'Alex', source: 'hint' as const },
      { ...unknown('others:B'), label: 'Casey', source: 'voiceprint' as const, score: 0.6 },
      { ...unknown('others:C'), label: 'Jordan', source: 'calendar' as const },
      { ...unknown('others:D'), label: 'Morgan', source: 'meet' as const },
      { ...unknown('others:E'), label: 'Sam', source: 'user' as const }
    ]
    const result = retireUnverifiedNames(old, [])
    expect(result.map(s => s.source)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'user'])
    expect(result[0]).toMatchObject({ label: 'Speaker 1', suggestion: 'Alex' })
    expect(result[4].label).toBe('Sam')
  })
  it('does not treat calendar invitations as confirmed attendance', () => {
    const people = [{ name: 'Alex Rivera', email: null }]
    expect(authoritativeParticipants(people)).toEqual([])
    expect(applyParticipantNames([unknown()], people)[0].source).toBe('unknown')
  })
  it('keeps a weak voice match unconfirmed even when that person is on the roster', () => {
    const people = ['Alex Rivera', 'Casey Morgan'].map(name => ({ name, email: null, source: 'meet' as const, rosterComplete: true }))
    expect(applyParticipantNames([{ ...unknown(), suggestion: 'Alex Rivera', score: 0.6 }], people)[0])
      .toMatchObject({ source: 'unknown', label: 'Speaker 1', suggestion: 'Alex Rivera', score: 0.6, personId: null })
  })
  it('accepts the sole verified remote participant and preserves the actual source', () => {
    for (const source of ['meet', 'user'] as const) {
      expect(applyParticipantNames([unknown()], [{ name: 'Alex Rivera', email: null, source, rosterComplete: true }])[0])
        .toMatchObject({ label: 'Alex Rivera', source })
    }
    expect(applyParticipantNames([unknown()], [{ name: 'Alex Rivera', email: null, source: 'meet', rosterComplete: false }])[0].source)
      .toBe('unknown')
  })
  it('keeps AI proposals as suggestions even when the name appears in a complete roster', () => {
    const people = [{ name: 'Alex Rivera', email: null, source: 'meet' as const, rosterComplete: true }]
    expect(applyConversationSuggestions([unknown()], [{ speaker: 'Speaker 1', name: 'Alex' }], people)[0])
      .toMatchObject({ label: 'Speaker 1', source: 'unknown', suggestion: 'Alex Rivera' })
    expect(applyConversationSuggestions([unknown()], [{ speaker: 'Speaker 1', name: 'Alex' }],
      [...people, { ...people[0], name: 'Alex Chen' }])[0].suggestion).toBe('Alex')
  })
  it('cannot overwrite a confirmed speaker with an AI proposal', () => {
    const speaker = { ...unknown(), label: 'Alex Rivera', source: 'user' as const }
    expect(applyConversationSuggestions([speaker], [{ speaker: 'Alex Rivera', name: 'Casey' }], [])[0]).toEqual(speaker)
  })
  it('restores a confirmation by voice when reprocessing changes speaker keys, without enrolling it globally', () => {
    const current = [{ key: 'others:B', channel: 'others' as const, seconds: 30, embedding: [1, 0], firstStartMs: 0 },
      { key: 'others:A', channel: 'others' as const, seconds: 30, embedding: [0, 1], firstStartMs: 1000 }]
    const saved = [{ speaker: { ...unknown('others:A'), label: 'Alex Rivera', source: 'user' as const }, embedding: [1, 0] }]
    expect(restoreConfirmedNames([unknown('others:B'), unknown('others:A')], current, saved, 'slack').map(s => [s.key, s.label, s.source, s.personId]))
      .toEqual([['others:B', 'Alex Rivera', 'user', null], ['others:A', 'Speaker 1', 'unknown', null]])
    expect(restoreConfirmedNames([unknown()], [{ ...current[0], key: 'others:A', embedding: [0, 1] }], saved, 'slack')[0].source).toBe('unknown')
  })
})
