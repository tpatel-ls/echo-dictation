import { describe, expect, it } from 'vitest'
import { meetingTitle } from '@shared/meeting-title'
import type { MeetingNotes } from '@shared/meeting-types'

const notes: MeetingNotes = { summary: ['Discussed the hiring plan for next quarter.'], decisions: [], actionItems: [], openQuestions: [], model: 'test', verifiedBy: null }

describe('meeting titles', () => {
  it('uses a generated topic for an untitled Slack huddle without overriding an explicit title', () => {
    expect(meetingTitle('slack', null, { ...notes, title: 'Release Planning' })).toBe('Release Planning')
    expect(meetingTitle('slack', null, null)).toBeNull()
    expect(meetingTitle('slack', 'Design review', { ...notes, title: 'Release Planning' })).toBe('Design review')
  })
  it('prefers a concise topic and upgrades the legacy summary title without changing a custom title', () => {
    const titled = { ...notes, title: 'Quarterly Hiring Plan' }
    expect(meetingTitle('google-meet', 'abc-defg-hij', titled)).toBe('Quarterly Hiring Plan')
    expect(meetingTitle('google-meet', 'Discussed the hiring plan for next quarter', titled)).toBe('Quarterly Hiring Plan')
    expect(meetingTitle('google-meet', 'My team review', titled)).toBe('My team review')
    expect(meetingTitle('google-meet', 'abc-defg-hij', { ...notes, summary: ['Speaker 1 outlined a vision for the next release.'] })).toBe('abc-defg-hij')
  })
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
