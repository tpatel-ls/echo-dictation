import { matchMeetingEvent, occurrencesBetween, parseIcs, participantsOf, type IcsEvent } from '@shared/ics'
import type { MeetingAppId, MeetingParticipant } from '@shared/meeting-types'

// The user's calendar, read from its private iCal address (Google Calendar's "secret address in
// iCal format", or an Outlook published calendar) without any sign-in: fetched at most every 10
// minutes, and again when a meeting starts. It names a recorded meeting's other participants. The
// address is a secret: it never appears in errors or logs.

const REFRESH_MS = 10 * 60_000
/** A meeting start refreshes the calendar, but not more often than this. */
const MIN_REFRESH_MS = 60_000
const TIMEOUT_MS = 15_000

export class CalendarError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'CalendarError'
  }
}

export interface CalendarDeps {
  /** The saved address (a secret); empty when no calendar is set up. */
  url: () => string
  fetch?: typeof fetch
  now?: () => number
  log?: (message: string) => void
}

export class CalendarSource {
  private cache: { url: string; at: number; events: IcsEvent[] } | null = null
  private inflight: Promise<IcsEvent[]> | null = null

  constructor(private readonly deps: CalendarDeps) {}

  /** The calendar's events, or null when no calendar is set up. Throws CalendarError on failure. */
  async events(opts: { refresh?: boolean } = {}): Promise<IcsEvent[] | null> {
    const url = this.deps.url().trim()
    if (!url) return null
    const now = (this.deps.now ?? Date.now)()
    const c = this.cache
    const age = c && c.url === url ? now - c.at : Infinity
    if (c && age < (opts.refresh ? MIN_REFRESH_MS : REFRESH_MS)) return c.events
    this.inflight ??= this.fetchEvents(url, now).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /** How many events the calendar has today (local day), for the Settings test button. */
  async eventsToday(): Promise<number> {
    const events = (await this.events({ refresh: true })) ?? []
    const now = new Date((this.deps.now ?? Date.now)())
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    return occurrencesBetween(events, from, from + 86_400_000).length
  }

  /**
   * The other participants of the calendar event a meeting belongs to, or null when there is no
   * calendar, it cannot be read, or no event matches. Never throws.
   */
  async participants(
    meeting: { app: MeetingAppId; title: string | null; startedAt: number },
    self: { name: string; email: string },
    opts: { refresh?: boolean } = {}
  ): Promise<MeetingParticipant[] | null> {
    try {
      const events = await this.events(opts)
      if (!events) return null
      const event = matchMeetingEvent(events, meeting)
      if (!event) {
        this.deps.log?.(`calendar: no event matched the meeting (${events.length} events read)`)
        return null
      }
      const people = participantsOf(event, self)
      this.deps.log?.(`calendar: matched an event with ${people.length} other participant(s)`)
      return people
    } catch (e) {
      this.deps.log?.(`calendar: could not read it (${(e as Error).name}${(e as CalendarError).status ? ` ${(e as CalendarError).status}` : ''})`)
      return null
    }
  }

  private async fetchEvents(url: string, now: number): Promise<IcsEvent[]> {
    const target = url.replace(/^webcals?:\/\//i, 'https://')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let res: Response
    try {
      res = await (this.deps.fetch ?? fetch)(target, { signal: controller.signal, redirect: 'follow' })
    } catch (e) {
      throw new CalendarError(controller.signal.aborted ? 'The calendar did not answer in time' : `Could not reach the calendar (${(e as Error).name})`)
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new CalendarError(`Calendar returned ${res.status}`, res.status)
    const text = await res.text()
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new CalendarError('The address did not return an iCalendar file')
    const events = parseIcs(text)
    this.cache = { url, at: now, events }
    return events
  }
}
