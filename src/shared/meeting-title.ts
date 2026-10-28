import type { MeetingAppId, MeetingNotes } from './meeting-types'

/** Replace an opaque Meet code with a known calendar name or a concise existing summary. */
export function meetingTitle(
  app: MeetingAppId, title: string | null, notes: MeetingNotes | null, calendarTitle?: string | null
): string | null {
  if (app !== 'google-meet' || (title && !/^(?:Meet\s*[-–]\s*)?[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(title.trim()))) return title
  const source = calendarTitle?.trim() || notes?.summary.find(s => typeof s === 'string' && s.trim())?.trim()
  if (!source) return title
  const clean = source.replace(/\s+/g, ' ').replace(/[.!]+$/, '')
  return clean.length <= 90 ? clean : clean.slice(0, 87).replace(/\s+\S*$/, '') + '…'
}
