import { describe, it, expect } from 'vitest'
import { formatClock, meetingFileName, renderMarkdown, renderText, type ExportMeeting } from '@shared/meeting-export'
import type { MeetingNotes, MeetingSpeaker } from '@shared/meeting-types'

// Expectations use the same local-time getters as the code, so the suite passes in any timezone.
const START = new Date(2026, 8, 22, 14, 5, 30).getTime()
const END = START + 42 * 60_000

const pad = (n: number) => String(n).padStart(2, '0')
const localDate = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const localTime = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function speaker(key: string, label: string, source: MeetingSpeaker['source'] = 'unknown'): MeetingSpeaker {
  return { key, label, source, personId: null, suggestion: null, score: null, seconds: 10 }
}

const NOTES: MeetingNotes = {
  summary: ['Agreed the launch plan.', 'Budget is still open.'],
  decisions: [{ text: 'Ship on Friday.', cites: ['u1'], verification: 'supported' }],
  actionItems: [
    { text: 'Draft the release notes', owner: 'Blake', due: 'Thursday', cites: ['u2'], verification: 'supported' },
    { text: 'Book the room', owner: null, due: null, cites: ['u3'], verification: 'insufficient' },
    { text: 'Email finance', owner: 'Tanay', cites: ['u4'], verification: 'unverified' }
  ],
  openQuestions: [],
  model: 'claude',
  verifiedBy: null
}

function meeting(extra: Partial<ExportMeeting> = {}): ExportMeeting {
  return {
    app: 'google-meet',
    title: 'abc-defg-hij',
    startedAt: START,
    endedAt: END,
    speakers: [speaker('others:SPEAKER_00', 'Blake Whitmore', 'hint'), speaker('me', 'Tanay', 'self')],
    notes: NOTES,
    utterances: [
      { start: 0, end: 3000, channel: 'mic', speakerKey: 'me', text: 'Morning, Blake.' },
      { start: 723_000, end: 730_000, channel: 'others', speakerKey: 'others:SPEAKER_00', text: 'Let us ship Friday.' },
      { start: 3_725_000, end: 3_726_000, channel: 'others', speakerKey: 'others:SPEAKER_07', text: 'Hi.' }
    ],
    ...extra
  }
}

const INFO = `${localDate(START)} · ${localTime(START)}–${localTime(END)} · 42 min · Participants: Tanay, Blake Whitmore`

describe('formatClock', () => {
  it('formats elapsed time as hh:mm:ss', () => {
    expect(formatClock(0)).toBe('00:00:00')
    expect(formatClock(723_999)).toBe('00:12:03')
    expect(formatClock(3_725_000)).toBe('01:02:05')
    expect(formatClock(-5)).toBe('00:00:00')
  })
})

describe('renderMarkdown', () => {
  it('renders header, notes and transcript', () => {
    expect(renderMarkdown(meeting())).toBe(
      [
        '# Google Meet - abc-defg-hij',
        '',
        INFO,
        '',
        '## Summary',
        '',
        '- Agreed the launch plan.',
        '- Budget is still open.',
        '',
        '## Decisions',
        '',
        '- Ship on Friday.',
        '',
        '## Action items',
        '',
        '- [ ] Blake: Draft the release notes (due Thursday)',
        '- [ ] Book the room _(needs check)_',
        '- [ ] Tanay: Email finance',
        '',
        '## Transcript',
        '',
        '**[00:00:00] Tanay:** Morning, Blake.',
        '',
        '**[00:12:03] Blake Whitmore:** Let us ship Friday.',
        '',
        '**[01:02:05] others:SPEAKER_07:** Hi.',
        ''
      ].join('\n')
    )
  })

  it('omits the title, the notes sections and the end time when absent', () => {
    const md = renderMarkdown(meeting({ title: null, notes: null, endedAt: null }))
    expect(md.split('\n').slice(0, 5)).toEqual([
      '# Google Meet',
      '',
      `${localDate(START)} · ${localTime(START)} · Participants: Tanay, Blake Whitmore`,
      '',
      '## Transcript'
    ])
    expect(md).not.toContain('## Summary')
  })

  it('flags insufficient items in every section', () => {
    const notes: MeetingNotes = {
      ...NOTES,
      summary: [],
      decisions: [{ text: 'Maybe Friday.', cites: [], verification: 'insufficient' }],
      openQuestions: [{ text: 'Who pays?', cites: [], verification: 'insufficient' }]
    }
    const md = renderMarkdown(meeting({ notes }))
    expect(md).not.toContain('## Summary')
    expect(md).toContain('## Decisions\n\n- Maybe Friday. _(needs check)_\n')
    expect(md).toContain('## Open questions\n\n- Who pays? _(needs check)_\n')
  })
})

describe('renderText', () => {
  it('renders the header and one line per utterance', () => {
    expect(renderText(meeting())).toBe(
      [
        'Google Meet - abc-defg-hij',
        INFO,
        '',
        '[00:00:00] Tanay: Morning, Blake.',
        '[00:12:03] Blake Whitmore: Let us ship Friday.',
        '[01:02:05] others:SPEAKER_07: Hi.',
        ''
      ].join('\n')
    )
  })
})

describe('meetingFileName', () => {
  const stamp = (() => {
    const d = new Date(START)
    return `${localDate(START)} ${pad(d.getHours())}${pad(d.getMinutes())}`
  })()

  it('names the file by local start time, app and title', () => {
    expect(meetingFileName(meeting(), 'md')).toBe(`${stamp} Google Meet - abc-defg-hij.md`)
    expect(meetingFileName(meeting({ app: 'slack', title: null }), 'txt')).toBe(`${stamp} Slack huddle.txt`)
  })

  it('replaces characters Windows forbids and trims trailing dots and spaces', () => {
    const title = 'Q3: plan / review <draft> "v2" a\\b|c?d*e\u0007f. . '
    expect(meetingFileName(meeting({ app: 'teams', title }), 'md')).toBe(
      `${stamp} Microsoft Teams - Q3- plan - review -draft- -v2- a-b-c-d-e-f.md`
    )
  })

  it('caps the title at 80 characters and drops a title that sanitises to nothing', () => {
    const name = meetingFileName(meeting({ title: 'x'.repeat(200) }), 'md')
    expect(name).toBe(`${stamp} Google Meet - ${'x'.repeat(80)}.md`)
    expect(meetingFileName(meeting({ title: ' ... ' }), 'md')).toBe(`${stamp} Google Meet.md`)
  })
})
