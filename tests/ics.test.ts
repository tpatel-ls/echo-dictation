import { describe, it, expect } from 'vitest'
import { parseIcs, occurrencesBetween, matchMeetingEvent, participantsOf, nameFromEmail } from '@shared/ics'

const CRLF = (lines: string[]): string => lines.join('\r\n') + '\r\n'

// A Google Calendar "secret address in iCal format" export, trimmed to what matters.
const GOOGLE = CRLF([
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTSTART:20260923T125800Z',
  'DTEND:20260923T132800Z',
  'UID:review-1@google.com',
  'ORGANIZER;CN=Tanay Mehra:mailto:tanay@example.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN="Kadiro, Darin";X-NUM-GUESTS=0:mailto:darin.kadiro@example.org',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=tanay@example.com;X-NUM-GUESTS=0:mailto:tanay@example.com',
  'ATTENDEE;CUTYPE=RESOURCE;PARTSTAT=ACCEPTED;CN=Room 4:mailto:room4@resource.calendar.google.com',
  'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij',
  'DESCRIPTION:Join with Google Meet: https://meet.google.com/abc-defg-hij\\nOr dial',
  '  in: +1 555 0100',
  'SUMMARY:Invitation to Design Review - Northwind EU',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=America/Chicago:20260901T090000',
  'DTEND;TZID=America/Chicago:20260901T093000',
  'RRULE:FREQ=WEEKLY;BYDAY=TU,WE;UNTIL=20261231T000000Z',
  'EXDATE;TZID=America/Chicago:20260922T090000',
  'UID:standup@google.com',
  'SUMMARY:Daily standup',
  'ATTENDEE;CN=Blake Whitmore;PARTSTAT=ACCEPTED:mailto:blake@example.com',
  'ATTENDEE;CN=Priya Raman;PARTSTAT=DECLINED:mailto:priya@example.com',
  'LOCATION:https://teams.microsoft.com/l/meetup-join/19%3ameeting',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=America/Chicago:20260930T100000',
  'DTEND;TZID=America/Chicago:20260930T103000',
  'RECURRENCE-ID;TZID=America/Chicago:20260930T090000',
  'UID:standup@google.com',
  'SUMMARY:Daily standup (moved)',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260923',
  'DTEND;VALUE=DATE:20260924',
  'UID:holiday@google.com',
  'SUMMARY:Company holiday',
  'END:VEVENT',
  'END:VCALENDAR'
])

describe('parseIcs', () => {
  it('unfolds lines, unescapes text and reads attendees with quoted names', () => {
    const [interview] = parseIcs(GOOGLE)
    expect(interview.summary).toBe('Invitation to Design Review - Northwind EU')
    expect(interview.description).toBe('Join with Google Meet: https://meet.google.com/abc-defg-hij\nOr dial in: +1 555 0100')
    expect(interview.start).toBe(Date.UTC(2026, 8, 23, 12, 58))
    expect(interview.end).toBe(Date.UTC(2026, 8, 23, 13, 28))
    expect(interview.conference).toBe('https://meet.google.com/abc-defg-hij')
    expect(interview.organizer).toEqual({ name: 'Tanay Mehra', email: 'tanay@example.com', role: 'organizer', declined: false, resource: false })
    expect(interview.attendees.map((a) => [a.name, a.email, a.resource])).toEqual([
      ['Kadiro, Darin', 'darin.kadiro@example.org', false],
      [null, 'tanay@example.com', false],
      ['Room 4', 'room4@resource.calendar.google.com', true]
    ])
  })

  it('reads an all-day event and a zoned event', () => {
    const events = parseIcs(GOOGLE)
    const holiday = events.find((e) => e.uid === 'holiday@google.com')!
    expect(holiday.allDay).toBe(true)
    const standup = events.find((e) => e.uid === 'standup@google.com' && !e.recurrenceId)!
    // 09:00 in Chicago on 1 September 2026 is 14:00 UTC (daylight time).
    expect(standup.start).toBe(Date.UTC(2026, 8, 1, 14, 0))
  })

  it('reads a Windows time zone name as Outlook writes it', () => {
    const ics = CRLF([
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:x',
      'DTSTART;TZID=Central European Standard Time:20260923T145800',
      'DTEND;TZID=Central European Standard Time:20260923T152800',
      'SUMMARY:Sync',
      'END:VEVENT',
      'END:VCALENDAR'
    ])
    expect(parseIcs(ics)[0].start).toBe(Date.UTC(2026, 8, 23, 12, 58))
  })

  it('ignores garbage without throwing', () => {
    expect(parseIcs('not a calendar')).toEqual([])
    expect(parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:bad\nEND:VEVENT\nEND:VCALENDAR')).toEqual([])
  })
})

describe('occurrencesBetween', () => {
  const events = parseIcs(GOOGLE)
  const day = (d: number): [number, number] => [Date.UTC(2026, 8, d, 0, 0), Date.UTC(2026, 8, d + 1, 0, 0)]

  it('expands a weekly rule on the right days, keeping local time across the day', () => {
    const [from, to] = day(29) // Tuesday 29 September
    expect(occurrencesBetween(events, from, to).map((o) => [o.summary, o.start])).toEqual([['Daily standup', Date.UTC(2026, 8, 29, 14, 0)]])
  })

  it('skips an excluded date and applies a moved instance', () => {
    expect(occurrencesBetween(events, ...day(22)).filter((o) => o.uid === 'standup@google.com')).toEqual([])
    const moved = occurrencesBetween(events, ...day(30)).filter((o) => o.uid === 'standup@google.com')
    expect(moved.map((o) => [o.summary, o.start])).toEqual([['Daily standup (moved)', Date.UTC(2026, 8, 30, 15, 0)]])
  })

  it('includes one-off and all-day events of the day', () => {
    expect(occurrencesBetween(events, ...day(23)).map((o) => o.uid).sort()).toEqual(['holiday@google.com', 'review-1@google.com', 'standup@google.com'])
  })

  it('honours COUNT and a monthly day', () => {
    const ics = CRLF([
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:m',
      'DTSTART:20260115T160000Z',
      'DTEND:20260115T170000Z',
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=15;COUNT=9',
      'SUMMARY:Monthly review',
      'END:VEVENT',
      'END:VCALENDAR'
    ])
    const ev = parseIcs(ics)
    expect(occurrencesBetween(ev, Date.UTC(2026, 8, 15), Date.UTC(2026, 8, 16))).toHaveLength(1) // the 9th
    expect(occurrencesBetween(ev, Date.UTC(2026, 9, 15), Date.UTC(2026, 9, 16))).toHaveLength(0) // past COUNT
  })
})

describe('matchMeetingEvent', () => {
  const events = parseIcs(GOOGLE)
  const at = Date.UTC(2026, 8, 23, 12, 59)

  it('matches a Meet by its code in the conference data', () => {
    expect(matchMeetingEvent(events, { app: 'google-meet', title: 'abc-defg-hij', startedAt: at })?.uid).toBe('review-1@google.com')
  })

  it('matches by title plus a time overlap (Meet shows the event title in the tab)', () => {
    const m = matchMeetingEvent(events, { app: 'google-meet', title: 'Invitation to Design Review - Northwind EU', startedAt: at })
    expect(m?.uid).toBe('review-1@google.com')
    expect(matchMeetingEvent(events, { app: 'google-meet', title: 'Invitation to Design Review', startedAt: at + 6 * 3600_000 })).toBeNull()
  })

  it('falls back to the one event with a link to that app at that time', () => {
    expect(matchMeetingEvent(events, { app: 'google-meet', title: null, startedAt: at })?.uid).toBe('review-1@google.com')
    expect(matchMeetingEvent(events, { app: 'teams', title: null, startedAt: Date.UTC(2026, 8, 29, 14, 5) })?.uid).toBe('standup@google.com')
    expect(matchMeetingEvent(events, { app: 'zoom', title: null, startedAt: at })).toBeNull()
  })
})

describe('participantsOf', () => {
  const [interview] = parseIcs(GOOGLE)
  it('lists the other people, not the user, rooms or declined guests', () => {
    expect(participantsOf(interview, { name: 'Tanay', email: '' })).toEqual([{ name: 'Darin Kadiro', email: 'darin.kadiro@example.org' }])
    expect(participantsOf(interview, { name: '', email: 'tanay@example.com' })).toEqual([{ name: 'Darin Kadiro', email: 'darin.kadiro@example.org' }])
  })

  it('derives a name from an email when there is none', () => {
    expect(nameFromEmail('darin.kadiro@example.org')).toBe('Darin Kadiro')
    expect(nameFromEmail('blake_whitmore+work@example.com')).toBe('Blake Whitmore')
    expect(nameFromEmail('dkadiro@example.org')).toBe('Dkadiro')
  })
})
