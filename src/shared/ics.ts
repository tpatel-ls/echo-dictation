// ─────────────────────────────────────────────────────────────────────────────
// A small iCalendar (RFC 5545) reader for the "secret address in iCal format" that Google Calendar
// and Outlook publish: events, their attendees and conference links, and the instances of
// recurring events on a given day, so a recorded meeting can be matched to its calendar event and
// its participants named. It handles line folding, escaped text, quoted parameters, UTC, zoned
// (IANA or Windows names) and floating times, all-day events, and the common RRULE forms
// (DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY), EXDATE and moved
// or cancelled instances (RECURRENCE-ID). Pure: text in, data out; no network.
// ─────────────────────────────────────────────────────────────────────────────

import type { MeetingAppId, MeetingParticipant } from './meeting-types'

export interface IcsPerson {
  name: string | null
  email: string | null
  role: 'organizer' | 'attendee'
  declined: boolean
  /** A room or other resource, not a person. */
  resource: boolean
}

interface LocalTime {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  s: number
}

interface IcsTime {
  utc: number
  /** Wall-clock parts in `tzid` (for expanding a rule across daylight-saving changes). */
  local: LocalTime
  tzid: string | null
  floating: boolean
  allDay: boolean
}

export interface IcsEvent {
  uid: string
  summary: string
  description: string
  location: string
  /** The conference link (Google's X-GOOGLE-CONFERENCE), when the event has one. */
  conference: string | null
  start: number
  end: number
  allDay: boolean
  cancelled: boolean
  organizer: IcsPerson | null
  attendees: IcsPerson[]
  rrule: string | null
  /** Set on a moved or cancelled instance of a recurring event: the original start (UTC ms). */
  recurrenceId: number | null
  /** Excluded instances (UTC ms of their start). */
  exdates: number[]
  /** Internal: the parsed start, to expand rules in the right wall-clock time. */
  startTime: IcsTime
}

/** One instance of an event in a time window. */
export type IcsOccurrence = Omit<IcsEvent, 'rrule' | 'exdates' | 'startTime' | 'recurrenceId'>

// ── Lines and values ──────────────────────────────────────────────────────────

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

function unfold(text: string): string[] {
  return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/)
}

/** NAME;PARAM=value;PARAM="quoted:value":VALUE, with ':' and ';' allowed inside quotes. */
function parseLine(line: string): Prop | null {
  let i = 0
  let inQuotes = false
  let colon = -1
  for (; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === ':' && !inQuotes) {
      colon = i
      break
    }
  }
  if (colon < 0) return null
  const head = line.slice(0, colon)
  const parts: string[] = []
  let cur = ''
  inQuotes = false
  for (const ch of head) {
    if (ch === '"') inQuotes = !inQuotes
    if (ch === ';' && !inQuotes) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: parts[0].toUpperCase(), params, value: line.slice(colon + 1) }
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

// ── Time ──────────────────────────────────────────────────────────────────────

/** Outlook writes Windows zone names; the common ones, as IANA zones. */
const WINDOWS_ZONES: Record<string, string> = {
  'UTC': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Singapore Standard Time': 'Asia/Singapore',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Arabian Standard Time': 'Asia/Dubai',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Turkey Standard Time': 'Europe/Istanbul'
}

function ianaZone(tzid: string): string | null {
  const name = WINDOWS_ZONES[tzid] ?? tzid.replace(/^\/[^/]+\/[^/]+\//, '') // "/mozilla.org/.../Europe/Berlin"
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return name
  } catch {
    return null
  }
}

/** The zone's offset from UTC (ms) at a UTC instant. */
function zoneOffset(utc: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(new Date(utc))
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utc
}

/** Wall-clock time in a zone (null zone: this machine's local time) to UTC ms. */
function toUtc(t: LocalTime, zone: string | null): number {
  if (!zone) return new Date(t.y, t.mo - 1, t.d, t.h, t.mi, t.s).getTime()
  const guess = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s)
  let utc = guess - zoneOffset(guess, zone)
  utc = guess - zoneOffset(utc, zone) // settle across a daylight-saving change
  return utc
}

function parseTime(prop: Prop): IcsTime | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(prop.value.trim())
  if (!m) return null
  const local = { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) }
  const allDay = m[4] === undefined
  if (m[7]) return { utc: Date.UTC(local.y, local.mo - 1, local.d, local.h, local.mi, local.s), local, tzid: 'UTC', floating: false, allDay }
  const tzid = prop.params.TZID ?? null
  const zone = tzid ? ianaZone(tzid) : null
  return { utc: toUtc(local, allDay ? null : zone), local, tzid: zone, floating: !zone, allDay }
}

// ── People ────────────────────────────────────────────────────────────────────

function person(prop: Prop, role: IcsPerson['role']): IcsPerson {
  const email = /^mailto:/i.test(prop.value) ? prop.value.replace(/^mailto:/i, '').trim().toLowerCase() : null
  const cn = prop.params.CN?.trim() || null
  // Google repeats the address as the name when it has no name.
  const name = cn && cn.toLowerCase() !== email ? cn : null
  const cutype = (prop.params.CUTYPE ?? 'INDIVIDUAL').toUpperCase()
  return {
    name,
    email,
    role,
    declined: (prop.params.PARTSTAT ?? '').toUpperCase() === 'DECLINED',
    resource: cutype === 'RESOURCE' || cutype === 'ROOM' || /@resource\.calendar\.google\.com$/.test(email ?? '')
  }
}

/** "darin.kadiro@x" → "Darin Kadiro"; "blake_whitmore+work@x" → "Blake Whitmore". */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0].split('+')[0]
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/** "Kadiro, Darin" → "Darin Kadiro". */
function displayName(name: string): string {
  const m = /^([^,]+),\s*([^,]+)$/.exec(name.trim())
  return m ? `${m[2].trim()} ${m[1].trim()}` : name.trim()
}

// ── Events ────────────────────────────────────────────────────────────────────

export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = []
  let cur: Prop[] | null = null
  let depth = 0
  for (const line of unfold(text)) {
    const upper = line.toUpperCase()
    if (upper === 'BEGIN:VEVENT') {
      cur = []
      depth = 0
      continue
    }
    if (!cur) continue
    if (upper.startsWith('BEGIN:')) depth++ // VALARM and friends
    else if (upper.startsWith('END:') && upper !== 'END:VEVENT') depth--
    else if (upper === 'END:VEVENT') {
      const ev = toEvent(cur)
      if (ev) events.push(ev)
      cur = null
    } else if (depth === 0) {
      const prop = parseLine(line)
      if (prop) cur.push(prop)
    }
  }
  return events
}

function toEvent(props: Prop[]): IcsEvent | null {
  const one = (name: string): Prop | undefined => props.find((p) => p.name === name)
  const startProp = one('DTSTART')
  const start = startProp ? parseTime(startProp) : null
  if (!start) return null
  const endProp = one('DTEND')
  let end = endProp ? parseTime(endProp)?.utc ?? null : null
  if (end === null) {
    const dur = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(one('DURATION')?.value ?? '')
    end = dur ? start.utc + ((+(dur[1] ?? 0) * 24 + +(dur[2] ?? 0)) * 60 + +(dur[3] ?? 0)) * 60_000 : start.utc + (start.allDay ? 86_400_000 : 0)
  }
  const recurrence = one('RECURRENCE-ID')
  const exdates = props
    .filter((p) => p.name === 'EXDATE')
    .flatMap((p) => p.value.split(',').map((v) => parseTime({ ...p, value: v })?.utc))
    .filter((v): v is number => typeof v === 'number')
  const organizer = one('ORGANIZER')
  return {
    uid: one('UID')?.value ?? '',
    summary: unescapeText(one('SUMMARY')?.value ?? ''),
    description: unescapeText(one('DESCRIPTION')?.value ?? ''),
    location: unescapeText(one('LOCATION')?.value ?? ''),
    conference: one('X-GOOGLE-CONFERENCE')?.value ?? null,
    start: start.utc,
    end,
    allDay: start.allDay,
    cancelled: (one('STATUS')?.value ?? '').toUpperCase() === 'CANCELLED',
    organizer: organizer ? person(organizer, 'organizer') : null,
    attendees: props.filter((p) => p.name === 'ATTENDEE').map((p) => person(p, 'attendee')),
    rrule: one('RRULE')?.value ?? null,
    recurrenceId: recurrence ? parseTime(recurrence)?.utc ?? null : null,
    exdates,
    startTime: start
  }
}

// ── Recurrence ────────────────────────────────────────────────────────────────

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const MAX_DAYS = 20 * 366

function occurrence(ev: IcsEvent, start: number): IcsOccurrence {
  const { rrule: _r, exdates: _e, startTime: _s, recurrenceId: _id, ...rest } = ev
  return { ...rest, start, end: start + (ev.end - ev.start) }
}

/** Does the rule produce this calendar day? (`n` counts matching days so far, for COUNT.) */
function ruleDays(ev: IcsEvent, from: number, to: number): number[] {
  const rule = Object.fromEntries(
    (ev.rrule ?? '').split(';').map((kv) => kv.split('=') as [string, string]).filter(([k]) => k)
  ) as Record<string, string>
  const freq = rule.FREQ
  const interval = Math.max(1, Number(rule.INTERVAL ?? 1))
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity
  const until = rule.UNTIL ? parseTime({ name: 'UNTIL', params: {}, value: rule.UNTIL })?.utc ?? Infinity : Infinity
  const byDay = (rule.BYDAY ?? '').split(',').filter(Boolean).map((d) => {
    const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(d)
    return m ? { ord: m[1] ? Number(m[1]) : null, day: WEEKDAYS.indexOf(m[2]) } : null
  }).filter((d): d is { ord: number | null; day: number } => d !== null && d.day >= 0)
  const byMonthDay = (rule.BYMONTHDAY ?? '').split(',').filter(Boolean).map(Number)
  const s = ev.startTime.local
  const zone = ev.startTime.tzid === 'UTC' ? 'UTC' : ev.startTime.floating ? null : ev.startTime.tzid
  const base = Date.UTC(s.y, s.mo - 1, s.d)
  const out: number[] = []
  let n = 0
  for (let i = 0; i < MAX_DAYS; i++) {
    const dayUtc = base + i * 86_400_000
    const date = new Date(dayUtc)
    const y = date.getUTCFullYear()
    const mo = date.getUTCMonth() + 1
    const d = date.getUTCDate()
    const wd = date.getUTCDay()
    let matches = false
    if (freq === 'DAILY') matches = i % interval === 0
    else if (freq === 'WEEKLY') {
      const week = Math.floor((i + ((new Date(base).getUTCDay() + 6) % 7)) / 7)
      const days = byDay.length ? byDay.map((b) => b.day) : [new Date(base).getUTCDay()]
      matches = week % interval === 0 && days.includes(wd)
    } else if (freq === 'MONTHLY') {
      const months = (y - s.y) * 12 + (mo - s.mo)
      if (months % interval === 0) {
        if (byMonthDay.length) matches = byMonthDay.includes(d)
        else if (byDay.length) {
          const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate()
          matches = byDay.some((b) => {
            if (b.day !== wd) return false
            if (b.ord === null) return true
            const nth = Math.ceil(d / 7)
            const fromEnd = -Math.ceil((dim - d + 1) / 7)
            return b.ord === nth || b.ord === fromEnd
          })
        } else matches = d === s.d
      }
    } else if (freq === 'YEARLY') matches = (y - s.y) % interval === 0 && mo === s.mo && d === s.d
    if (!matches) continue
    const start = toUtc({ y, mo, d, h: s.h, mi: s.mi, s: s.s }, zone)
    if (start < ev.startTime.utc) continue
    n++
    if (n > count || start > until) break
    if (start >= to) break
    if (start + (ev.end - ev.start) > from) out.push(start)
  }
  return out
}

/** Instances overlapping [from, to), recurring rules expanded, moved and cancelled ones applied. */
export function occurrencesBetween(events: IcsEvent[], from: number, to: number): IcsOccurrence[] {
  const overrides = events.filter((e) => e.recurrenceId !== null)
  const out: IcsOccurrence[] = []
  for (const ev of events) {
    if (ev.recurrenceId !== null) continue
    const starts = ev.rrule ? ruleDays(ev, from, to) : ev.start < to && ev.end > from ? [ev.start] : []
    for (const start of starts) {
      if (ev.exdates.includes(start)) continue
      if (overrides.some((o) => o.uid === ev.uid && o.recurrenceId === start)) continue
      if (!ev.cancelled) out.push(occurrence(ev, start))
    }
  }
  for (const o of overrides) {
    if (!o.cancelled && o.start < to && o.end > from) out.push(occurrence(o, o.start))
  }
  return out.sort((a, b) => a.start - b.start)
}

// ── Matching a recorded meeting ───────────────────────────────────────────────

const MEET_CODE = /\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/
const APP_LINKS: Partial<Record<MeetingAppId, RegExp>> = {
  'google-meet': /meet\.google\.com\//i,
  teams: /teams\.microsoft\.com\/|teams\.live\.com\//i,
  zoom: /zoom\.us\/|zoomgov\.com\//i,
  webex: /webex\.com\//i
}
/** How far around an event a recording may start and still be that event. */
const EARLY_MS = 15 * 60_000
const LATE_MS = 30 * 60_000

function norm(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * The calendar event a recording belongs to: by the Meet code in its conference data, else by its
 * title with the recording starting during it, else the one event with a link to that app then.
 */
export function matchMeetingEvent(
  events: IcsEvent[],
  meeting: { app: MeetingAppId; title: string | null; startedAt: number }
): IcsOccurrence | null {
  const near = occurrencesBetween(events, meeting.startedAt - LATE_MS - 12 * 3600_000, meeting.startedAt + EARLY_MS + 12 * 3600_000).filter(
    (o) => !o.allDay
  )
  const during = near.filter((o) => meeting.startedAt >= o.start - EARLY_MS && meeting.startedAt <= o.end + LATE_MS)
  const closest = (list: IcsOccurrence[]): IcsOccurrence | null =>
    list.sort((a, b) => Math.abs(a.start - meeting.startedAt) - Math.abs(b.start - meeting.startedAt))[0] ?? null
  const haystack = (o: IcsOccurrence): string => `${o.conference ?? ''} ${o.location} ${o.description}`

  const code = meeting.title ? MEET_CODE.exec(meeting.title.toLowerCase())?.[1] : undefined
  if (code) {
    const byCode = near.filter((o) => haystack(o).toLowerCase().includes(code))
    if (byCode.length) return closest(byCode.filter((o) => during.includes(o)).length ? byCode.filter((o) => during.includes(o)) : byCode)
  }
  if (meeting.title && norm(meeting.title)) {
    const t = norm(meeting.title)
    const byTitle = during.filter((o) => {
      const s = norm(o.summary)
      return s === t || (t.length >= 8 && (s.includes(t) || t.includes(s)))
    })
    if (byTitle.length) return closest(byTitle)
  }
  const link = APP_LINKS[meeting.app]
  const byApp = link ? during.filter((o) => link.test(haystack(o))) : []
  return byApp.length === 1 ? byApp[0] : null
}

/** The event's people other than the user (and rooms, and anyone who declined), with display names. */
export function participantsOf(
  event: Pick<IcsOccurrence, 'organizer' | 'attendees'>,
  self: { name: string; email: string }
): MeetingParticipant[] {
  const selfEmail = self.email.trim().toLowerCase()
  const selfName = norm(self.name)
  const out: MeetingParticipant[] = []
  for (const p of [...(event.organizer ? [event.organizer] : []), ...event.attendees]) {
    if (p.resource || p.declined) continue
    const name = p.name ? displayName(p.name) : p.email ? nameFromEmail(p.email) : null
    if (!name) continue
    const isSelf =
      (selfEmail && p.email === selfEmail) ||
      (selfName && (norm(name) === selfName || norm(name).split(' ')[0] === selfName.split(' ')[0]))
    if (isSelf) continue
    if (out.some((o) => (p.email && o.email === p.email) || norm(o.name) === norm(name))) continue
    out.push({ name, email: p.email })
  }
  return out
}
