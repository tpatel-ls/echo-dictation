// ─────────────────────────────────────────────────────────────────────────────
// Meeting export: the .md copy written to the output folder (notes + transcript), a plain-text
// transcript, and a Windows-safe file name. Pure; dates render in the machine's local time.
// ─────────────────────────────────────────────────────────────────────────────

import type { MeetingAppId, MeetingNotes, MeetingSpeaker, MeetingUtterance, NoteItem } from './meeting-types'
import { MEETING_APP_LABELS, SELF_SPEAKER_KEY } from './meeting-types'

export interface ExportMeeting {
  app: MeetingAppId
  title: string | null
  startedAt: number
  endedAt: number | null
  speakers: MeetingSpeaker[]
  notes: MeetingNotes | null
  utterances: MeetingUtterance[]
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Elapsed time as 'hh:mm:ss', e.g. '00:12:03'. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)}`
}

function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function localTime(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function heading(m: Pick<ExportMeeting, 'app' | 'title'>): string {
  const label = MEETING_APP_LABELS[m.app]
  return m.title ? `${label} - ${m.title}` : label
}

function participants(speakers: MeetingSpeaker[]): string[] {
  const ordered = [...speakers.filter((s) => s.key === SELF_SPEAKER_KEY), ...speakers.filter((s) => s.key !== SELF_SPEAKER_KEY)]
  return [...new Set(ordered.map((s) => s.label))]
}

/** '2026-09-22 · 14:05–14:47 · 42 min · Participants: Tanay, Blake Whitmore' */
function infoLine(m: ExportMeeting): string {
  const parts = [localDate(m.startedAt)]
  if (m.endedAt !== null) {
    parts.push(`${localTime(m.startedAt)}–${localTime(m.endedAt)}`)
    parts.push(`${Math.max(1, Math.round((m.endedAt - m.startedAt) / 60_000))} min`)
  } else {
    parts.push(localTime(m.startedAt))
  }
  const names = participants(m.speakers)
  if (names.length > 0) parts.push(`Participants: ${names.join(', ')}`)
  return parts.join(' · ')
}

function labeller(speakers: MeetingSpeaker[]): (key: string) => string {
  const labels = new Map(speakers.map((s) => [s.key, s.label]))
  return (key) => labels.get(key) ?? key
}

function flag(item: NoteItem): string {
  return item.verification === 'insufficient' ? ' _(needs check)_' : ''
}

function section(title: string, lines: string[]): string[] {
  return lines.length > 0 ? [`## ${title}`, '', ...lines, ''] : []
}

function notesSections(notes: MeetingNotes): string[] {
  const actionItem = (i: NoteItem): string => {
    const owner = i.owner ? `${i.owner}: ` : ''
    const due = i.due ? ` (due ${i.due})` : ''
    return `- [ ] ${owner}${i.text}${due}${flag(i)}`
  }
  return [
    ...section('Summary', notes.summary.map((s) => `- ${s}`)),
    ...section('Decisions', notes.decisions.map((i) => `- ${i.text}${flag(i)}`)),
    ...section('Action items', notes.actionItems.map(actionItem)),
    ...section('Open questions', notes.openQuestions.map((i) => `- ${i.text}${flag(i)}`))
  ]
}

export function renderMarkdown(m: ExportMeeting): string {
  const label = labeller(m.speakers)
  const lines = [`# ${heading(m)}`, '', infoLine(m), '']
  if (m.notes) lines.push(...notesSections(m.notes))
  lines.push('## Transcript', '')
  for (const u of m.utterances) lines.push(`**[${formatClock(u.start)}] ${label(u.speakerKey)}:** ${u.text}`, '')
  return lines.join('\n')
}

export function renderText(m: ExportMeeting): string {
  const label = labeller(m.speakers)
  const lines = [heading(m), infoLine(m), '']
  for (const u of m.utterances) lines.push(`[${formatClock(u.start)}] ${label(u.speakerKey)}: ${u.text}`)
  lines.push('')
  return lines.join('\n')
}

const TITLE_MAX = 80

function safeTitle(title: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX)
  return cleaned.replace(/[. ]+$/, '')
}

/** 'YYYY-MM-DD HHmm <App>[ - <title>].<ext>' in local time, safe as a Windows file name. */
export function meetingFileName(m: Pick<ExportMeeting, 'app' | 'title' | 'startedAt'>, ext: 'md' | 'txt'): string {
  const d = new Date(m.startedAt)
  const stamp = `${localDate(m.startedAt)} ${pad2(d.getHours())}${pad2(d.getMinutes())}`
  const title = m.title ? safeTitle(m.title) : ''
  return `${stamp} ${heading({ app: m.app, title: title || null })}.${ext}`
}
