import { expect, it } from 'vitest'
import { relabelMeetingNotes } from '@shared/meeting-note-labels'
import type { MeetingNotes, MeetingSpeaker } from '@shared/meeting-types'

it('updates generated note names simultaneously as speakers are confirmed and renumbered', () => {
  const before: MeetingSpeaker[] = ['Speaker 1', 'Speaker 2'].map((label, i) => ({ key: `others:${i}`, label, source: 'unknown',
    personId: null, score: null, suggestion: null, seconds: 30 }))
  const after = [{ ...before[0], label: 'Alex Rivera' }, { ...before[1], label: 'Speaker 1' }]
  const notes: MeetingNotes = { title: 'Speaker 1 and Speaker 2', summary: ['Speaker 1 asked Speaker 2. Speaker 10 listened.'],
    decisions: [{ text: "Speaker 2's plan", cites: ['u1'], verification: 'supported', confidence: 0.9 }],
    actionItems: [{ text: 'Speaker 1 sends it.', owner: 'Speaker 2', due: 'Monday', cites: ['u2'], verification: 'unverified' }],
    openQuestions: [], model: 'test', verifiedBy: null }
  const result = relabelMeetingNotes(notes, before, after)
  expect(result?.summary).toEqual(['Alex Rivera asked Speaker 1. Speaker 10 listened.'])
  expect(result?.title).toBe('Alex Rivera and Speaker 1')
  expect(result?.decisions[0]).toMatchObject({ text: "Speaker 1's plan", cites: ['u1'], verification: 'unverified' })
  expect(result?.decisions[0].confidence).toBeUndefined()
  expect(result?.actionItems[0]).toMatchObject({ text: 'Alex Rivera sends it.', owner: 'Speaker 1', due: 'Monday' })
  expect(notes.summary[0]).toContain('Speaker 2')
})
