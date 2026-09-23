import { describe, it, expect, vi } from 'vitest'
import { CalendarSource } from '../src/main/meetings/calendar'

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:review',
  'DTSTART:20260923T125800Z',
  'DTEND:20260923T132800Z',
  'SUMMARY:Invitation to Design Review',
  'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij',
  'ORGANIZER;CN=Tanay Mehra:mailto:tanay@example.com',
  'ATTENDEE;CN=Darin Kadiro;PARTSTAT=ACCEPTED:mailto:darin@example.org',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n')

const URL = 'https://calendar.google.com/calendar/ical/me%40example.com/private-secret123/basic.ics'
const NOW = Date.UTC(2026, 8, 23, 13, 0)

function setup(opts: { url?: string; body?: string; status?: number } = {}) {
  let now = NOW
  const fetch = vi.fn(async (_url: string) => new Response(opts.body ?? ICS, { status: opts.status ?? 200 }))
  const logs: string[] = []
  const source = new CalendarSource({
    url: () => opts.url ?? URL,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => now,
    log: (m) => logs.push(m)
  })
  return { source, fetch, logs, advance: (ms: number) => (now += ms) }
}

describe('CalendarSource', () => {
  it('does nothing without a calendar address', async () => {
    const { source, fetch } = setup({ url: '' })
    expect(await source.events()).toBeNull()
    expect(await source.participants({ app: 'google-meet', title: 'abc-defg-hij', startedAt: NOW }, { name: 'Tanay', email: '' })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches at most every 10 minutes', async () => {
    const { source, fetch, advance } = setup()
    await source.events()
    advance(9 * 60_000)
    await source.events()
    expect(fetch).toHaveBeenCalledTimes(1)
    advance(2 * 60_000)
    await source.events()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('refreshes when a meeting starts, but not twice in a minute', async () => {
    const { source, fetch, advance } = setup()
    await source.events()
    advance(90_000)
    await source.events({ refresh: true })
    expect(fetch).toHaveBeenCalledTimes(2)
    await source.events({ refresh: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reads webcal addresses over https', async () => {
    const { source, fetch } = setup({ url: 'webcal://outlook.office365.com/owa/calendar/x/calendar.ics' })
    await source.events()
    expect(fetch.mock.calls[0][0]).toBe('https://outlook.office365.com/owa/calendar/x/calendar.ics')
  })

  it('names the other attendees of the matching event', async () => {
    const { source } = setup()
    const people = await source.participants({ app: 'google-meet', title: 'abc-defg-hij', startedAt: NOW }, { name: 'Tanay', email: '' })
    expect(people).toEqual([{ name: 'Darin Kadiro', email: 'darin@example.org' }])
  })

  it('counts the events of the day for the settings test', async () => {
    const { source } = setup()
    expect(await source.eventsToday()).toBe(1)
  })

  it('reports a failed fetch without the address (it is a secret)', async () => {
    const { source, logs } = setup({ status: 404 })
    await expect(source.events()).rejects.toThrow('Calendar returned 404')
    await expect(source.events()).rejects.not.toThrow(/secret123/)
    expect(await source.participants({ app: 'google-meet', title: 'x', startedAt: NOW }, { name: 'Tanay', email: '' })).toBeNull()
    expect(logs.join('\n')).not.toContain('secret123')
  })

  it('rejects something that is not a calendar', async () => {
    const { source } = setup({ body: '<html>Sign in</html>' })
    await expect(source.events()).rejects.toThrow('did not return an iCalendar file')
  })
})
