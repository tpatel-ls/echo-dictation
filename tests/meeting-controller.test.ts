import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { MeetingsStore } from '../src/main/store/meetings'
import { VoiceprintStore } from '../src/main/store/voiceprints'
import { MeetingController, type MeetingControllerDeps, type MeetingUi } from '../src/main/meetings/controller'
import { speakersFilePath } from '../src/main/meetings/finalize'
import type {
  MeetingEvent,
  MeetingHelper,
  MicSession,
  ProbeResult,
  RecordLevels,
  RecordMicPaused,
  RecordStarted,
  RecordStartRequest,
  RecordStopped,
  RecordWarning
} from '@shared/meeting-types'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'echo-controller-'))
  vi.useFakeTimers({ now: new Date(2026, 8, 22, 14, 0) })
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

const CHROME: MicSession = {
  pid: 200,
  appPid: 100,
  exe: 'chrome.exe',
  path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  packageFamily: null,
  endpointId: '{mic-endpoint}',
  endpointName: 'Microphone'
}

function meetProbe(opts: { tab?: string | null; peak?: number; renderPid?: number } = {}): ProbeResult {
  const tab = opts.tab === undefined ? 'Meet - abc-defg-hij - Microphone recording' : opts.tab
  return {
    windows: [],
    tabs: tab ? [{ appPid: 100, exe: 'chrome.exe', name: tab }] : [],
    render: [{ pid: opts.renderPid ?? 300, appPid: 100, exe: 'chrome.exe', endpointId: '{spk}', active: true, peak: opts.peak ?? 0.05 }]
  }
}

class FakeHelper implements MeetingHelper {
  available = true
  started = 0
  stopped = 0
  probeResult: ProbeResult = meetProbe()
  probes: string[][] = []
  startRequests: RecordStartRequest[] = []
  stopRequests: string[] = []
  retargets: Array<{ id: string; otherPids: number[] }> = []
  startError: Error | null = null
  pauseError: Error | null = null
  micPauses: Array<{ id: string; paused: boolean }> = []
  private recordStart = 0
  private sessionCbs = new Set<(s: MicSession[]) => void>()
  private levelCbs = new Set<(l: RecordLevels) => void>()
  start(): void {
    this.started++
  }
  stop(): void {
    this.stopped++
  }
  onMicSessions(cb: (s: MicSession[]) => void): () => void {
    this.sessionCbs.add(cb)
    return () => this.sessionCbs.delete(cb)
  }
  onLevels(cb: (l: RecordLevels) => void): () => void {
    this.levelCbs.add(cb)
    return () => this.levelCbs.delete(cb)
  }
  onWarning(_cb: (w: RecordWarning) => void): () => void {
    return () => {}
  }
  async probe(exes: string[]): Promise<ProbeResult> {
    this.probes.push(exes)
    return this.probeResult
  }
  async startRecording(req: RecordStartRequest): Promise<RecordStarted> {
    if (this.startError) throw this.startError
    this.startRequests.push(req)
    this.recordStart = Date.now()
    return { id: req.id, startedAt: Date.now(), othersMode: 'process', micName: 'Microphone' }
  }
  retarget(id: string, otherPids: number[]): void {
    this.retargets.push({ id, otherPids })
  }
  async stopRecording(id: string): Promise<RecordStopped> {
    this.stopRequests.push(id)
    return { id, samples: 16_000 * 42 }
  }
  async setMicPaused(id: string, paused: boolean): Promise<RecordMicPaused> {
    if (this.pauseError) throw this.pauseError
    this.micPauses.push({ id, paused })
    return { id, paused, samples: Math.round(((Date.now() - this.recordStart) * 16_000) / 1000) }
  }
  sessions(s: MicSession[]): void {
    for (const cb of this.sessionCbs) cb(s)
  }
  levels(l: RecordLevels): void {
    for (const cb of this.levelCbs) cb(l)
  }
}

function setup(
  settingsPatch: Partial<Settings> = {},
  platform: NodeJS.Platform = 'win32',
  calendar?: MeetingControllerDeps['calendar']
) {
  const db = new SQL.Database()
  const meetings = new MeetingsStore(db)
  const voiceprints = new VoiceprintStore(db)
  const helper = new FakeHelper()
  let settings: Settings = { ...DEFAULT_SETTINGS, meetingMode: 'auto', meetingUserName: 'Tanay', ...settingsPatch }
  const events: MeetingEvent[] = []
  const notes: Array<{ title: string; body: string; meetingId: number | null }> = []
  const pill: string[] = []
  const tray: boolean[] = []
  const logs: string[] = []
  const finalized: number[] = []
  // The overlay capsule "shows" a meeting whenever the live phase is not idle.
  let lastPhase = 'idle'
  const ui: MeetingUi = {
    emit: (e) => {
      events.push(e)
      if (e.type !== 'live') return
      const visible = e.state.phase !== 'idle'
      if (visible !== (lastPhase !== 'idle')) pill.push(visible ? 'show' : 'hide')
      lastPhase = e.state.phase
    },
    notify: ({ kind: _kind, ...n }) => notes.push(n),
    recordingChanged: (s) => tray.push(s.recording)
  }
  const meetingsDir = path.join(root, 'meetings')
  let n = 0
  const controller = new MeetingController({
    platform,
    settings: () => settings,
    meetings,
    voiceprints,
    dictionary: () => [],
    helper,
    meetingsDir,
    ui,
    transcribeLive: async () => '',
    finalize: async (id) => {
      finalized.push(id)
    },
    osUserName: () => 'jdoe',
    calendar,
    log: (m) => logs.push(m),
    uuid: () => `uuid-${++n}`
  })
  const setSettings = (patch: Partial<Settings>): void => {
    settings = { ...settings, ...patch }
    controller.applySettings(settings)
  }
  return { controller, helper, meetings, voiceprints, events, notes, pill, tray, logs, finalized, meetingsDir, setSettings }
}

/** Start a Meet call that has remote audio: recording begins 3 s after the first snapshot. */
async function startMeet(h: ReturnType<typeof setup>): Promise<number> {
  h.controller.start()
  h.helper.sessions([CHROME])
  await vi.advanceTimersByTimeAsync(3100)
  const rows = h.meetings.byStatus(['recording'])
  expect(rows).toHaveLength(1)
  return rows[0].id
}

describe('MeetingController', () => {
  it('starts the helper only on Windows with meetings on', () => {
    const off = setup({ meetingMode: 'off' })
    off.controller.start()
    expect(off.helper.started).toBe(0)
    const mac = setup({}, 'darwin')
    mac.controller.start()
    expect(mac.helper.started).toBe(0)
    const on = setup()
    on.controller.start()
    expect(on.helper.started).toBe(1)
  })

  it('never probes while no meeting app holds the mic', async () => {
    const h = setup()
    h.controller.start()
    h.helper.sessions([{ ...CHROME, exe: 'obs64.exe', appPid: 9 }])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.helper.probes).toEqual([])
    expect(h.meetings.list()).toEqual([])
  })

  it('starts recording a confirmed meeting: row, helper request, pill, notification, live event', async () => {
    const h = setup()
    h.controller.start()
    h.helper.sessions([CHROME])
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.helper.startRequests).toHaveLength(0) // not yet 3 s
    await vi.advanceTimersByTimeAsync(1100)

    expect(h.helper.probes[0]).toEqual(['chrome.exe'])
    const [req] = h.helper.startRequests
    expect(req).toEqual({ id: 'uuid-1', dir: path.join(h.meetingsDir, 'uuid-1'), otherPids: [300], micEndpointId: '{mic-endpoint}' })
    expect(existsSync(req.dir)).toBe(true)
    const row = h.meetings.list()[0]
    expect(row).toMatchObject({ status: 'recording', app: 'google-meet', title: 'abc-defg-hij', audio_dir: req.dir })
    expect(row.speakers.map((s) => s.label)).toEqual(['Tanay', 'Others'])
    expect(h.pill).toEqual(['show']) // shown when detected, stays up while recording
    expect(h.tray.at(-1)).toBe(true)
    expect(h.notes).toEqual([
      {
        title: 'Recording started: Google Meet',
        body: 'Echo is transcribing this meeting. Use the pill to pause your mic, stop, or discard.',
        meetingId: row.id
      }
    ])
    expect(h.controller.live()).toMatchObject({ recording: true, meetingId: row.id, app: 'google-meet' })
    expect(h.events.some((e) => e.type === 'live' && e.state.recording)).toBe(true)
  })

  it('does not start a silent lobby within 90 s', async () => {
    const h = setup()
    h.helper.probeResult = meetProbe({ peak: 0 })
    h.controller.start()
    h.helper.sessions([CHROME])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.helper.startRequests).toHaveLength(0)
    h.helper.probeResult = meetProbe({ peak: 0.05 })
    await vi.advanceTimersByTimeAsync(3500) // two probes hear the far end
    expect(h.helper.startRequests).toHaveLength(1)
  })

  it('keeps the title current and retargets when the app\'s audio processes change', async () => {
    const h = setup()
    const id = await startMeet(h)
    h.helper.probeResult = meetProbe({ tab: 'Meet - Weekly sync - Microphone recording', renderPid: 301 })
    await vi.advanceTimersByTimeAsync(2100)
    expect(h.meetings.get(id)!.title).toBe('Weekly sync')
    expect(h.controller.live().title).toBe('Weekly sync')
    expect(h.helper.retargets).toEqual([{ id: 'uuid-1', otherPids: [301] }])
  })

  it('accumulates name hints, most frequent first', async () => {
    const h = setup()
    h.controller.start()
    const slack: MicSession = { ...CHROME, exe: 'slack.exe', appPid: 50, pid: 50 }
    const slackProbe = (title: string): ProbeResult => ({
      windows: [{ pid: 50, appPid: 50, exe: 'slack.exe', title, className: 'Chrome_WidgetWin_1', minimized: false }],
      tabs: [],
      render: [{ pid: 50, appPid: 50, exe: 'slack.exe', endpointId: '{spk}', active: true, peak: 0.05 }]
    })
    h.helper.probeResult = slackProbe('Blake Whitmore (DM) - Acme - Slack')
    h.helper.sessions([slack])
    await vi.advanceTimersByTimeAsync(9000)
    h.helper.probeResult = slackProbe('Priya Raman (DM) - Acme - Slack')
    await vi.advanceTimersByTimeAsync(2100)
    const row = h.meetings.byStatus(['recording'])[0]
    expect(row.name_hints).toEqual(['Blake Whitmore', 'Priya Raman'])
  })

  it('stops soon after the meeting is gone, hides the pill, and queues the final pass', async () => {
    const h = setup()
    const id = await startMeet(h)
    h.helper.probeResult = meetProbe({ tab: null }) // the Meet tab is gone: the call was left
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.helper.stopRequests).toEqual([]) // inside the short end grace
    await vi.advanceTimersByTimeAsync(4500)
    expect(h.helper.stopRequests).toEqual(['uuid-1'])
    const row = h.meetings.get(id)!
    expect(row.status).toBe('processing')
    // Trimmed to the last moment the call was live (the start tick) plus one probe interval (the call
    // ended somewhere between that tick and the next), not the helper's 42 s.
    expect(row.ended_at! - row.started_at).toBe(2000)
    expect(h.controller.live()).toMatchObject({ phase: 'ended', ended: 'saved', recording: false, meetingId: id })
    expect(h.notes.at(-1)).toEqual({
      title: 'Recording ended: Google Meet · 1 min',
      body: "Echo is writing your notes. You'll get another notification when they're ready.",
      meetingId: id
    })
    expect(h.tray.at(-1)).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.finalized).toEqual([id])
    // "Saved · processing notes" for about 4 s, then the pill hides.
    expect(h.pill).toEqual(['show'])
    await vi.advanceTimersByTimeAsync(4000)
    expect(h.pill).toEqual(['show', 'hide'])
    expect(h.controller.live().phase).toBe('idle')
  })

  it('ends a Slack huddle about 15 s after it ends and keeps nothing after it (meeting 5)', async () => {
    const h = setup()
    const slack: MicSession = { ...CHROME, exe: 'slack.exe', appPid: 50, pid: 50 }
    const slackProbe = (peak: number): ProbeResult => ({
      windows: [{ pid: 50, appPid: 50, exe: 'slack.exe', title: 'Blake Whitmore (DM) - Acme - Slack', className: 'Chrome_WidgetWin_1', minimized: false }],
      tabs: [],
      render: [{ pid: 50, appPid: 50, exe: 'slack.exe', endpointId: '{spk}', active: true, peak }]
    })
    h.controller.start()
    h.helper.probeResult = slackProbe(0.05)
    h.helper.sessions([slack])
    await vi.advanceTimersByTimeAsync(3100)
    const id = h.meetings.byStatus(['recording'])[0].id
    await vi.advanceTimersByTimeAsync(20_000) // the huddle (shorter than the fake helper's 42 s)
    // The huddle ends: Slack releases the mic and goes digitally silent; its main window stays.
    const endedAt = Date.now()
    h.helper.probeResult = slackProbe(0)
    h.helper.sessions([])
    await vi.advanceTimersByTimeAsync(12_000)
    expect(h.helper.stopRequests).toEqual([]) // within 15 s of the last sound
    await vi.advanceTimersByTimeAsync(6000)
    expect(h.helper.stopRequests).toEqual(['uuid-1']) // not 60 s + 15 s later
    const row = h.meetings.get(id)!
    expect(row.ended_at!).toBeLessThanOrEqual(endedAt + 2000)
    expect(row.ended_at!).toBeGreaterThan(endedAt - 4000)
  })

  it('trims the audio and the live transcript to the moment the call ended', async () => {
    const h = setup()
    const id = await startMeet(h)
    const row0 = h.meetings.get(id)!
    await vi.advanceTimersByTimeAsync(20_000) // the call goes on
    const dir = row0.audio_dir!
    writeFileSync(path.join(dir, 'mic.pcm'), Buffer.alloc(16_000 * 2 * 42))
    writeFileSync(path.join(dir, 'others.pcm'), Buffer.alloc(16_000 * 2 * 42))
    h.meetings.appendSegment(id, { start_ms: 5000, end_ms: 15_000, channel: 'others', speaker_key: 'others', text: 'during', pass: 'live' })
    h.meetings.appendSegment(id, { start_ms: 25_000, end_ms: 30_000, channel: 'others', speaker_key: 'others', text: 'after', pass: 'live' })
    const liveUntil = Date.now() - 1 // the last tick saw the call
    h.helper.probeResult = meetProbe({ tab: null })
    h.helper.sessions([])
    await vi.advanceTimersByTimeAsync(8000)
    const row = h.meetings.get(id)!
    expect(row.status).toBe('processing')
    const keepMs = row.ended_at! - row.started_at
    expect(keepMs).toBeGreaterThan(18_000)
    expect(keepMs).toBeLessThanOrEqual(liveUntil - row.started_at + 2000)
    const bytes = Math.round((keepMs * 16_000) / 1000) * 2
    expect(readFileSync(path.join(dir, 'mic.pcm')).length).toBe(bytes)
    expect(readFileSync(path.join(dir, 'others.pcm')).length).toBe(bytes)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.meetings.segments(id).map((s) => s.text)).toEqual(['during'])
    expect(h.logs.some((l) => /trimmed [0-9]+ s recorded after the meeting ended/.test(l))).toBe(true)
  })

  it('keeps observing after the app releases the mic, so the recording still ends', async () => {
    const h = setup()
    const id = await startMeet(h)
    // Tab closed: no meeting app holds the mic, no new snapshots follow.
    h.helper.probeResult = meetProbe({ tab: null, peak: 0 })
    h.helper.sessions([])
    await vi.advanceTimersByTimeAsync(17_000)
    expect(h.meetings.get(id)!.status).toBe('processing')
  })

  it('keeps recording through a long mute that releases the mic while the others talk', async () => {
    const h = setup()
    const id = await startMeet(h)
    const probesBefore = h.helper.probes.length
    h.helper.probeResult = meetProbe({ tab: 'Meet - abc-defg-hij - Audio playing' })
    h.helper.sessions([]) // muted: Meet released the mic
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.meetings.get(id)!.status).toBe('recording')
    // The recorded app is still probed although no mic session is left.
    expect(h.helper.probes.length).toBeGreaterThan(probesBefore + 100)
    expect(h.helper.probes.at(-1)).toEqual(['chrome.exe'])

    // Unmuting continues the same recording: no second meeting.
    h.helper.probeResult = meetProbe()
    h.helper.sessions([CHROME])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.meetings.list()).toHaveLength(1)
    expect(h.helper.startRequests).toHaveLength(1)
    expect(h.meetings.get(id)!.status).toBe('recording')
  })

  it('ends a muted recording after 60 s of silence from the far end', async () => {
    const h = setup()
    const id = await startMeet(h)
    h.helper.probeResult = meetProbe({ tab: 'Meet - abc-defg-hij', peak: 0 }) // tab lingers, nothing plays
    h.helper.sessions([])
    await vi.advanceTimersByTimeAsync(55_000)
    expect(h.meetings.get(id)!.status).toBe('recording')
    await vi.advanceTimersByTimeAsync(25_000)
    expect(h.meetings.get(id)!.status).toBe('processing')
    // Back to idle: with no meeting app on the mic, probing stops.
    const probes = h.helper.probes.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.helper.probes.length).toBe(probes)
  })

  it('a call stopped while muted stays stopped after a long mute and the unmute', async () => {
    const h = setup()
    await startMeet(h)
    // Zoom holding the mic outside a meeting (no meeting window) keeps detection probing.
    const other: MicSession = { ...CHROME, exe: 'zoom.exe', appPid: 900, pid: 901 }
    h.helper.probeResult = meetProbe({ tab: 'Meet - abc-defg-hij - Audio playing' })
    h.helper.sessions([other]) // muted in Meet
    await vi.advanceTimersByTimeAsync(3000)
    await h.controller.stop()
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    h.helper.probeResult = meetProbe()
    h.helper.sessions([CHROME, other]) // unmuted
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.helper.startRequests).toHaveLength(1)
    expect(h.meetings.list().filter((m) => m.app === 'google-meet')).toHaveLength(1)
  })

  it('discards: deletes the row and the audio, and never processes', async () => {
    const h = setup()
    const id = await startMeet(h)
    const dir = h.meetings.get(id)!.audio_dir!
    await h.controller.discard()
    expect(h.meetings.get(id)).toBeNull()
    expect(existsSync(dir)).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.finalized).toEqual([])
    expect(h.helper.startRequests).toHaveLength(1) // suppressed: the same call does not restart
  })

  it('a user stop processes the meeting and does not restart the same call', async () => {
    const h = setup()
    const id = await startMeet(h)
    await h.controller.stop()
    expect(h.meetings.get(id)!.status).toBe('processing')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.helper.startRequests).toHaveLength(1)
    expect(h.finalized).toEqual([id])
  })

  it('marks the meeting failed when the recording cannot start, without retrying in a loop', async () => {
    const h = setup()
    h.helper.startError = new Error('Meeting helper is not running')
    h.controller.start()
    h.helper.sessions([CHROME])
    await vi.advanceTimersByTimeAsync(30_000)
    const rows = h.meetings.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'failed', audio_dir: null })
    expect(rows[0].error).toContain('Meeting helper is not running')
    expect(h.notes.map((n) => n.title)).toEqual(["Echo couldn't record Google Meet"])
    expect(h.pill).toEqual(['show', 'hide']) // detected, then gone once the call is suppressed
    expect(h.controller.live().phase).toBe('idle')
  })

  it('turning meetings off stops the recording as disabled and stops the helper', async () => {
    const h = setup()
    const id = await startMeet(h)
    h.setSettings({ meetingMode: 'off' })
    await vi.advanceTimersByTimeAsync(10)
    expect(h.helper.stopRequests).toEqual(['uuid-1'])
    expect(h.meetings.get(id)!.status).toBe('processing')
    expect(h.helper.stopped).toBe(1)
    expect(h.logs.some((l) => l.includes('disabled'))).toBe(true)
  })

  it('throttles level events to 4 per second', async () => {
    const h = setup()
    await startMeet(h)
    const before = h.events.filter((e) => e.type === 'live').length
    for (let i = 0; i < 10; i++) {
      h.helper.levels({ id: 'uuid-1', mic: 0.1, others: 0.2, samples: 1000 * i })
      await vi.advanceTimersByTimeAsync(100)
    }
    const after = h.events.filter((e) => e.type === 'live').length
    expect(after - before).toBeLessThanOrEqual(4)
    expect(h.controller.live()).toMatchObject({ mic: 0.1, others: 0.2 })
  })

  it('recovers interrupted meetings at startup', async () => {
    const h = setup({ meetingMode: 'off' })
    const dir = path.join(h.meetingsDir, 'crashed')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'mic.pcm'), Buffer.alloc(16_000 * 2 * 5))
    writeFileSync(path.join(dir, 'others.pcm'), Buffer.alloc(16_000 * 2 * 5))
    const crashed = h.meetings.create({ uuid: 'crashed', started_at: 1_000_000, app: 'teams', title: null, audio_dir: dir, name_hints: [] })
    const processing = h.meetings.create({ uuid: 'p', started_at: 2_000_000, app: 'teams', title: null, audio_dir: dir, name_hints: [] })
    h.meetings.update(processing.id, { status: 'processing' })
    h.controller.start()
    expect(h.meetings.get(crashed.id)).toMatchObject({ status: 'processing', ended_at: 1_005_000 })
    await vi.advanceTimersByTimeAsync(10)
    expect(h.finalized).toEqual([crashed.id, processing.id])
  })

  it('quit stops the recording cleanly and leaves it for the next launch', async () => {
    const h = setup()
    const id = await startMeet(h)
    await h.controller.shutdown()
    expect(h.helper.stopRequests).toEqual(['uuid-1'])
    expect(h.meetings.get(id)!.status).toBe('processing')
    expect(h.helper.stopped).toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.finalized).toEqual([])
  })

  it('reprocess queues the final pass, or refuses when the audio is gone', async () => {
    const h = setup({ meetingMode: 'off' })
    h.controller.start()
    const dir = path.join(h.meetingsDir, 'r')
    mkdirSync(dir, { recursive: true })
    const row = h.meetings.create({ uuid: 'r', started_at: 1, app: 'zoom', title: null, audio_dir: dir, name_hints: [] })
    h.meetings.update(row.id, { status: 'failed', error: 'boom' })
    await h.controller.reprocess(row.id)
    expect(h.meetings.get(row.id)).toMatchObject({ status: 'processing', error: null })
    await vi.advanceTimersByTimeAsync(10)
    expect(h.finalized).toEqual([row.id])
    h.meetings.update(row.id, { status: 'ready', audio_dir: null })
    await expect(h.controller.reprocess(row.id)).rejects.toThrow('Audio was already deleted')
  })

  it('renames a speaker, remembers the voice, and relabels note owners', () => {
    const h = setup({ meetingMode: 'off' })
    const row = h.meetings.create({ uuid: 'm1', started_at: 1, app: 'google-meet', title: null, audio_dir: null, name_hints: [] })
    h.meetings.update(row.id, {
      status: 'ready',
      speakers: [
        { key: 'me', label: 'Tanay', source: 'self', personId: null, suggestion: null, score: null, seconds: 30 },
        { key: 'others:A', label: 'Speaker 1', source: 'unknown', personId: null, suggestion: null, score: null, seconds: 25 },
        { key: 'others:B', label: 'Speaker 2', source: 'unknown', personId: null, suggestion: null, score: null, seconds: 4 }
      ],
      notes: {
        summary: [],
        decisions: [],
        actionItems: [{ text: 'Send the deck', owner: 'Speaker 2', due: null, cites: ['u1'], verification: 'unverified' }],
        openQuestions: [],
        model: 'm',
        verifiedBy: null
      }
    })
    mkdirSync(h.meetingsDir, { recursive: true })
    writeFileSync(
      speakersFilePath(h.meetingsDir, 'm1'),
      JSON.stringify({
        embeddingModel: 'wespeaker',
        speakers: [
          { key: 'others:A', seconds: 25, embedding: [1, 0, 0] },
          { key: 'others:B', seconds: 4, embedding: [0, 1, 0] }
        ]
      })
    )
    const detail = h.controller.renameSpeaker(row.id, 'others:A', 'Blake Whitmore', true)!
    expect(detail.speakers.map((s) => s.label)).toEqual(['Tanay', 'Blake Whitmore', 'Speaker 1'])
    expect(detail.notes!.actionItems[0].owner).toBe('Speaker 1') // same speaker, renumbered
    expect(h.voiceprints.people()).toMatchObject([{ name: 'Blake Whitmore', exemplars: 1, seconds: 25 }])
    expect(h.voiceprints.candidates('wespeaker')).toHaveLength(1)

    // Under 10 s of voice: renamed, but not remembered.
    h.controller.renameSpeaker(row.id, 'others:B', 'Priya', true)
    expect(h.voiceprints.people().map((p) => p.name)).toEqual(['Blake Whitmore'])
  })

  it('rewrites the saved .md when a speaker is renamed', () => {
    const h = setup({ meetingMode: 'off' })
    const out = path.join(root, 'out')
    mkdirSync(out, { recursive: true })
    const row = h.meetings.create({ uuid: 'm2', started_at: new Date(2026, 8, 22, 9, 30).getTime(), app: 'teams', title: 'Sync', audio_dir: null, name_hints: [] })
    const file = path.join(out, '2026-09-22 0930 Microsoft Teams - Sync.md')
    writeFileSync(file, 'old')
    h.meetings.update(row.id, {
      status: 'ready',
      output_path: file,
      speakers: [{ key: 'others:A', label: 'Speaker 1', source: 'unknown', personId: null, suggestion: null, score: null, seconds: 25 }]
    })
    h.meetings.replaceWithFinal(row.id, [{ start_ms: 0, end_ms: 1000, channel: 'others', speaker_key: 'others:A', text: 'Hello there.' }])
    h.controller.renameSpeaker(row.id, 'others:A', 'Blake', false)
    expect(readFileSync(file, 'utf8')).toContain('**[00:00:00] Blake:** Hello there.')
    expect(h.meetings.get(row.id)!.output_path).toBe(file)
  })

  it('remove deletes the row, the audio and the stored voices', async () => {
    const h = setup({ meetingMode: 'off' })
    const dir = path.join(h.meetingsDir, 'x')
    mkdirSync(dir, { recursive: true })
    writeFileSync(speakersFilePath(h.meetingsDir, 'x'), '{}')
    const row = h.meetings.create({ uuid: 'x', started_at: 1, app: 'zoom', title: null, audio_dir: dir, name_hints: [] })
    await h.controller.remove(row.id)
    expect(h.meetings.get(row.id)).toBeNull()
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(speakersFilePath(h.meetingsDir, 'x'))).toBe(false)
  })

  it('never logs window titles', async () => {
    const h = setup()
    await startMeet(h)
    await h.controller.stop()
    expect(h.logs.join('\n')).not.toContain('abc-defg-hij')
  })

  describe('mic pause', () => {
    const muted = meetProbe({ tab: 'Meet - abc-defg-hij - Audio playing' })
    const pauses = (dir: string): Array<{ from: number; to: number | null }> =>
      JSON.parse(readFileSync(path.join(dir, 'mic-pauses.json'), 'utf8'))

    it('pauses the mic when the meeting app releases it and resumes when it comes back', async () => {
      const h = setup()
      const id = await startMeet(h)
      const dir = h.meetings.get(id)!.audio_dir!
      expect(h.controller.live().micPaused).toBe(false)
      await vi.advanceTimersByTimeAsync(2000)
      h.helper.probeResult = muted
      h.helper.sessions([]) // muted in Meet: the app released the mic
      await vi.advanceTimersByTimeAsync(10)
      expect(h.helper.micPauses).toEqual([{ id: 'uuid-1', paused: true }])
      expect(h.controller.live().micPaused).toBe(true)
      expect(h.events.some((e) => e.type === 'live' && e.state.micPaused)).toBe(true)
      const [first] = pauses(dir)
      expect(first.to).toBeNull()

      await vi.advanceTimersByTimeAsync(30_000)
      expect(h.meetings.get(id)!.status).toBe('recording') // the meeting goes on while muted
      h.helper.probeResult = meetProbe()
      h.helper.sessions([CHROME]) // unmuted
      await vi.advanceTimersByTimeAsync(10)
      expect(h.helper.micPauses.at(-1)).toEqual({ id: 'uuid-1', paused: false })
      expect(h.controller.live().micPaused).toBe(false)
      const [closed] = pauses(dir)
      expect(closed.from).toBe(first.from)
      expect(closed.to! - closed.from).toBe(30_010 * 16)
    })

    it('pauses and resumes on the user\'s command', async () => {
      const h = setup()
      await startMeet(h)
      const trayUpdates = h.tray.length
      await h.controller.setMicPaused(true)
      expect(h.controller.live().micPaused).toBe(true)
      expect(h.tray.length).toBeGreaterThan(trayUpdates) // the tray toggle follows
      await h.controller.setMicPaused(false)
      expect(h.controller.live().micPaused).toBe(false)
      expect(h.helper.micPauses).toEqual([
        { id: 'uuid-1', paused: true },
        { id: 'uuid-1', paused: false }
      ])
    })

    it('keeps a user pause when the app takes the mic back', async () => {
      const h = setup()
      await startMeet(h)
      await h.controller.setMicPaused(true)
      h.helper.probeResult = muted
      h.helper.sessions([])
      await vi.advanceTimersByTimeAsync(10)
      h.helper.probeResult = meetProbe()
      h.helper.sessions([CHROME])
      await vi.advanceTimersByTimeAsync(10)
      expect(h.controller.live().micPaused).toBe(true)
      expect(h.helper.micPauses).toEqual([{ id: 'uuid-1', paused: true }])
    })

    it('lets the user turn the mic back on while the app has it released', async () => {
      const h = setup()
      await startMeet(h)
      h.helper.probeResult = muted
      h.helper.sessions([])
      await vi.advanceTimersByTimeAsync(10)
      expect(h.controller.live().micPaused).toBe(true)
      await h.controller.setMicPaused(false)
      expect(h.controller.live().micPaused).toBe(false)
    })

    it('treats the mic as paused even if the helper cannot confirm it', async () => {
      const h = setup()
      const id = await startMeet(h)
      h.helper.pauseError = new Error('Meeting helper did not answer record-mic-pause in time')
      await h.controller.setMicPaused(true)
      expect(h.controller.live().micPaused).toBe(true)
      const spans = pauses(h.meetings.get(id)!.audio_dir!)
      expect(spans).toHaveLength(1)
      expect(spans[0].to).toBeNull()
    })

    it('starts every recording with the mic on', async () => {
      const h = setup()
      await startMeet(h)
      await h.controller.setMicPaused(true)
      await h.controller.stop()
      expect(h.controller.live().micPaused).toBe(false)
      // That call is suppressed; a different one starts with the mic on.
      h.helper.probeResult = {
        windows: [],
        tabs: [{ appPid: 101, exe: 'chrome.exe', name: 'Meet - xyz-abcd-efg - Microphone recording' }],
        render: [{ pid: 400, appPid: 101, exe: 'chrome.exe', endpointId: '{spk}', active: true, peak: 0.05 }]
      }
      h.helper.sessions([{ ...CHROME, appPid: 101, pid: 201 }])
      await vi.advanceTimersByTimeAsync(3100)
      expect(h.helper.startRequests).toHaveLength(2)
      expect(h.controller.live()).toMatchObject({ recording: true, micPaused: false })
      expect(h.helper.micPauses).toEqual([{ id: 'uuid-1', paused: true }])
    })

    it('ignores the toggle while nothing is recording', async () => {
      const h = setup()
      h.controller.start()
      await h.controller.setMicPaused(true)
      expect(h.helper.micPauses).toEqual([])
      expect(h.controller.live().micPaused).toBe(false)
    })
  })

  describe('detected, started and ended confirmations', () => {
    const lobby = (): ProbeResult => meetProbe({ peak: 0 })

    it('shows a waiting meeting as detected, and notifies only if it is still waiting 3 s later', async () => {
      const h = setup()
      h.helper.probeResult = lobby()
      h.controller.start()
      h.helper.sessions([CHROME])
      await vi.advanceTimersByTimeAsync(10)
      expect(h.controller.live()).toMatchObject({ phase: 'detected', app: 'google-meet', title: 'abc-defg-hij', recording: false, meetingId: null })
      expect(h.pill).toEqual(['show'])
      expect(h.events.some((e) => e.type === 'live' && e.state.phase === 'detected')).toBe(true)
      await vi.advanceTimersByTimeAsync(2500)
      expect(h.notes).toEqual([])
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.notes).toEqual([
        {
          title: 'Meeting detected: Google Meet',
          body: 'Echo starts transcribing when the call begins. Use the pill to record now or skip this meeting.',
          meetingId: null
        }
      ])
      expect(h.helper.startRequests).toHaveLength(0)
    })

    it('announces only the start when the call is already live', async () => {
      const h = setup()
      await startMeet(h)
      await vi.advanceTimersByTimeAsync(5000)
      expect(h.notes.map((n) => n.title)).toEqual(['Recording started: Google Meet'])
      expect(h.controller.live().phase).toBe('recording')
    })

    it('hides the pill without any notification when the lobby is left', async () => {
      const h = setup()
      h.helper.probeResult = lobby()
      h.controller.start()
      h.helper.sessions([CHROME])
      await vi.advanceTimersByTimeAsync(1500)
      h.helper.probeResult = meetProbe({ tab: null, peak: 0 })
      h.helper.sessions([])
      await vi.advanceTimersByTimeAsync(10_000)
      expect(h.pill).toEqual(['show', 'hide'])
      expect(h.controller.live().phase).toBe('idle')
      expect(h.notes).toEqual([])
    })

    it('"Record now" starts the waiting meeting at once', async () => {
      const h = setup()
      h.helper.probeResult = lobby()
      h.controller.start()
      h.helper.sessions([CHROME])
      await vi.advanceTimersByTimeAsync(10)
      await h.controller.startNow()
      expect(h.helper.startRequests).toHaveLength(1)
      expect(h.controller.live().phase).toBe('recording')
      await vi.advanceTimersByTimeAsync(5000)
      expect(h.notes.map((n) => n.title)).toEqual(['Recording started: Google Meet'])
    })

    it('"Don\'t record" skips the waiting meeting for as long as it lasts', async () => {
      const h = setup()
      h.helper.probeResult = lobby()
      h.controller.start()
      h.helper.sessions([CHROME])
      await vi.advanceTimersByTimeAsync(1000)
      await h.controller.stop()
      expect(h.controller.live().phase).toBe('idle')
      expect(h.pill).toEqual(['show', 'hide'])
      h.helper.probeResult = meetProbe() // the call begins
      await vi.advanceTimersByTimeAsync(120_000)
      expect(h.helper.startRequests).toHaveLength(0)
      expect(h.notes).toEqual([])
    })

    it('a discard shows "Recording discarded" briefly and sends no ended notification', async () => {
      const h = setup()
      await startMeet(h)
      await h.controller.discard()
      expect(h.controller.live()).toMatchObject({ phase: 'ended', ended: 'discarded', meetingId: null })
      expect(h.notes.map((n) => n.title)).toEqual(['Recording started: Google Meet'])
      await vi.advanceTimersByTimeAsync(3100)
      expect(h.controller.live().phase).toBe('idle')
      expect(h.pill).toEqual(['show', 'hide'])
    })
  })

  it('looks up the calendar when a recording starts and stores who attended', async () => {
    const participants = vi.fn(async () => [{ name: 'Darin Kadiro', email: 'darin@example.org' }])
    const h = setup({ meetingMyEmail: 'tanay@example.com' }, 'win32', { participants })
    const id = await startMeet(h)
    await vi.advanceTimersByTimeAsync(10)
    expect(participants).toHaveBeenCalledWith(
      { app: 'google-meet', title: 'abc-defg-hij', startedAt: h.meetings.get(id)!.started_at },
      { name: 'Tanay', email: 'tanay@example.com' },
      { refresh: true }
    )
    expect(h.meetings.get(id)!.participants).toEqual([{ name: 'Darin Kadiro', email: 'darin@example.org' }])
  })
})
