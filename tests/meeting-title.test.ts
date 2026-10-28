import { describe, expect, it } from 'vitest'
import { meetingTitle } from '@shared/meeting-title'
import type { MeetingNotes } from '@shared/meeting-types'

const notes: MeetingNotes = { summary: ['Discussed the hiring plan for next quarter.'], decisions: [], actionItems: [], openQuestions: [], model: 'test', verifiedBy: null }

describe('meeting titles', () => {
  it('uses the calendar title first, then the existing notes summary for Meet codes', () => {
    expect(meetingTitle('google-meet', 'abc-defg-hij', notes, 'Weekly hiring review')).toBe('Weekly hiring review')
    expect(meetingTitle('google-meet', 'abc-defg-hij', notes)).toBe('Discussed the hiring plan for next quarter')
    expect(meetingTitle('google-meet', 'abc-defg-hij', null)).toBe('abc-defg-hij')
  })
  it('keeps real meeting titles and other apps unchanged', () => {
    expect(meetingTitle('google-meet', 'Product review', notes)).toBe('Product review')
    expect(meetingTitle('slack', 'Alex', notes)).toBe('Alex')
  })
})
