import { dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { meetingFileName, renderMarkdown, renderText } from '@shared/meeting-export'
import {
  MEETINGS_IPC,
  type MeetingDetail,
  type MeetingRecord,
  type MeetingSummary,
  type Person,
  type SpeakerKey
} from '@shared/meeting-types'
import type { Settings } from '@shared/types'
import type { MeetingsStore } from '../store/meetings'
import type { VoiceprintStore } from '../store/voiceprints'
import { writeFileAtomic } from '../store/atomic-file'
import type { MeetingController } from './controller'
import { outputDirFor, utterancesOf } from './finalize'
import type { CalendarSource } from './calendar'

// Main-process side of `window.api.meetings`: one handler per MEETINGS_IPC channel. Events flow
// the other way through MeetingUi.emit (see index.ts).

export interface MeetingsIpcContext {
  controller: MeetingController
  meetings: MeetingsStore
  voiceprints: VoiceprintStore
  settings: () => Settings
  defaultOutputDir: () => string
  /** Open the dashboard on the Meetings page, selecting `meetingId` when given. */
  show: (meetingId: number | null) => void
  calendar: CalendarSource
  hasCalendar: () => boolean
}

/** A list row: display names in speaking-time order. */
export function toSummary(m: MeetingRecord): MeetingSummary {
  const speakers = [...m.speakers].sort((a, b) => b.seconds - a.seconds).map((s) => s.label)
  return {
    id: m.id,
    started_at: m.started_at,
    ended_at: m.ended_at,
    app: m.app,
    title: m.title,
    status: m.status,
    progress: m.progress,
    speakers: [...new Set(speakers)]
  }
}

export function registerMeetingsIpc(ctx: MeetingsIpcContext): void {
  const detail = (id: number): MeetingDetail | null => {
    const rec = ctx.meetings.get(id)
    return rec ? { ...rec, segments: ctx.meetings.segments(id) } : null
  }

  ipcMain.handle(MEETINGS_IPC.LIST, (): MeetingSummary[] => ctx.meetings.list().map(toSummary))
  ipcMain.handle(MEETINGS_IPC.GET, (_e, id: number) => detail(id))
  ipcMain.handle(MEETINGS_IPC.LIVE, () => ctx.controller.live())
  ipcMain.handle(MEETINGS_IPC.STOP, () => ctx.controller.stop())
  ipcMain.handle(MEETINGS_IPC.DISCARD, () => ctx.controller.discard())
  ipcMain.handle(MEETINGS_IPC.START_NOW, () => ctx.controller.startNow())
  ipcMain.handle(MEETINGS_IPC.TEST_CALENDAR, async (): Promise<number> => {
    if (!ctx.hasCalendar()) throw new Error('Add your calendar address first')
    return ctx.calendar.eventsToday()
  })
  ipcMain.handle(MEETINGS_IPC.SET_MIC_PAUSED, (_e, paused: boolean) => ctx.controller.setMicPaused(paused === true))
  ipcMain.handle(MEETINGS_IPC.REMOVE, (_e, id: number) => ctx.controller.remove(id))
  ipcMain.handle(
    MEETINGS_IPC.RENAME_SPEAKER,
    (_e, id: number, speakerKey: SpeakerKey, name: string, remember: boolean) =>
      ctx.controller.renameSpeaker(id, speakerKey, String(name ?? ''), Boolean(remember))
  )
  ipcMain.handle(MEETINGS_IPC.REPROCESS, (_e, id: number) => ctx.controller.reprocess(id))

  ipcMain.handle(MEETINGS_IPC.EXPORT, async (_e, id: number, format: 'md' | 'txt'): Promise<string | null> => {
    const m = detail(id)
    if (!m) throw new Error('Meeting not found')
    const ext = format === 'txt' ? 'txt' : 'md'
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save meeting transcript',
      defaultPath: meetingFileName({ app: m.app, title: m.title, startedAt: m.started_at }, ext),
      filters: ext === 'md' ? [{ name: 'Markdown', extensions: ['md'] }] : [{ name: 'Text', extensions: ['txt'] }]
    })
    if (canceled || !filePath) return null
    const exported = {
      app: m.app,
      title: m.title,
      startedAt: m.started_at,
      endedAt: m.ended_at,
      speakers: m.speakers,
      notes: m.notes,
      utterances: utterancesOf(m.segments)
    }
    writeFileAtomic(filePath, ext === 'md' ? renderMarkdown(exported) : renderText(exported))
    return filePath
  })

  ipcMain.handle(MEETINGS_IPC.OPEN_FOLDER, async (_e, id: number): Promise<void> => {
    const m = ctx.meetings.get(id)
    if (m?.output_path && existsSync(m.output_path)) {
      shell.showItemInFolder(m.output_path)
      return
    }
    const dir = outputDirFor(ctx.settings(), ctx.defaultOutputDir)
    mkdirSync(dir, { recursive: true })
    const error = await shell.openPath(dir)
    if (error) throw new Error(error)
  })

  ipcMain.handle(MEETINGS_IPC.PEOPLE, (): Person[] => ctx.voiceprints.people())
  ipcMain.handle(MEETINGS_IPC.FORGET_PERSON, (_e, personId: number) => ctx.voiceprints.forget(personId))
  ipcMain.handle(MEETINGS_IPC.SHOW, (_e, id: number | null) => ctx.show(typeof id === 'number' ? id : null))
}
