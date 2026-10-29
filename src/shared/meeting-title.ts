import type { MeetingAppId, MeetingNotes } from './meeting-types'

/** Replace an opaque Meet code with a known calendar name or a dedicated topic title. */
export function meetingTitle(
  app: MeetingAppId, title: string | null, notes: MeetingNotes | null, calendarTitle?: string | null
): string | null {
  const summary = notes?.summary.find(s => typeof s === 'string' && s.trim())?.trim()
  const legacy = summary?.replace(/\s+/g, ' ').replace(/[.!]+$/, '')
  const oldTitle = legacy && (legacy.length <= 90 ? legacy : legacy.slice(0, 87).replace(/\s+\S*$/, '') + '…')
  if (app !== 'google-meet' || (title && title !== oldTitle && !/^(?:Meet\s*[-–]\s*)?[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(title.trim()))) return title
  const source = calendarTitle?.trim() || conciseMeetingTitle(notes?.title) ||
    (summary && summary.length <= 80 && !/\bSpeaker\s+\d+\b/i.test(summary) ? summary : null)
  if (!source) return title
  const clean = source.replace(/\s+/g, ' ').replace(/[.!]+$/, '')
  return clean.length <= 90 ? clean : clean.slice(0, 87).replace(/\s+\S*$/, '') + '…'
}

export function conciseMeetingTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const title = value.replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '')
  if (title.length < 3 || title.length > 80 || title.split(' ').length > 12 ||
      /\bSpeaker\s+\d+\b|^(?:untitled|unknown|none|null|meeting)$/i.test(title)) return undefined
  return title
}
