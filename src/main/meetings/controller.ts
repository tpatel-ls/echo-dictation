import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, truncateSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { candidateExes, continuationEvidence, detectMeetings, probeExesFor } from '@shared/meeting-detect'
import { MeetingSession, type MeetingSessionConfig } from '@shared/meeting-session'
import { liveSpeakers, renameSpeaker } from '@shared/meeting-speakers'
import {
  MEETING_APP_LABELS,
  MEETING_SAMPLE_RATE,
  SELF_SPEAKER_KEY,
  type LiveMeetingState,
  type MeetingAppId,
  type MeetingCandidate,
  type MeetingDetail,
  type MeetingEvent,
  type MeetingHelper,
  type MeetingParticipant,
  type MeetingSessionAction,
  type MeetingSpeaker,
  type MeetingStopReason,
  type MicSession,
  type ProbeResult,
  type SpeakerKey
} from '@shared/meeting-types'
import type { DictionaryEntry, Settings } from '@shared/types'
import type { MeetingsStore } from '../store/meetings'
import type { VoiceprintStore } from '../store/voiceprints'
import { AUDIO_DELETED_ERROR, readSpeakersFile, speakersFilePath, writeMeetingMarkdown } from './finalize'
import { LiveTranscriber } from './live'
import { PcmTail, pcmSampleCount, writeMicPauses, type MicPauseSpan } from './pcm-file'
import { scheduleRetention } from './retention'

// MeetingController: turns the helper's mic-session snapshots into recordings. It probes only
// while an enabled meeting app holds the microphone (or is being recorded, since some apps release
// the mic on mute), feeds the pure detector and session machine,
// and applies their actions: create the meeting row, start/retarget/stop the helper's recording,
// run the live transcript, show the pill/tray/notification, and queue the final pass (one meeting
// at a time). It also recovers meetings interrupted by a crash or quit. While recording, the user's
// mic channel is paused (silence is recorded) on request or while the meeting app has released the
// mic (muted), so nothing said while muted reaches a transcript. Spec: the whole design.

/** Probe cadence while a meeting app holds the mic, and while recording. */
const PROBE_EVERY_MS = 1500
const PROBE_EVERY_RECORDING_MS = 2000
const LIVE_EVERY_MS = 2000
/** `live` events carrying levels are throttled to at most 4 per second. */
const LEVELS_EMIT_MS = 250
const SHUTDOWN_STOP_TIMEOUT_MS = 4000
/** A detected meeting still waiting this long gets a notification (a live call starts sooner). */
const DETECTED_NOTIFY_MS = 3000
/** How long the pill confirms a recording was saved, or discarded, before it hides. */
const SAVED_SHOWN_MS = 4000
const DISCARDED_SHOWN_MS = 3000
const STARTED_BODY = 'Echo is transcribing this meeting. Use the pill to pause your mic, stop, or discard.'
const ENDED_BODY = "Echo is writing your notes. You'll get another notification when they're ready."

/** What a notification announces; the overlay shows the same states on its own. */
export type MeetingNotifyKind = 'detected' | 'started' | 'ended' | 'record-failed' | 'notes-ready' | 'notes-failed'

export interface MeetingUi {
  /** Deliver an event to the dashboard and the overlay (whose capsule shows the meeting state). */
  emit(event: MeetingEvent): void
  /**
   * An announcement. The overlay shows every state; this is for the optional Windows notification
   * (clicking it opens the dashboard on `meetingId`, or the Meetings page when null).
   */
  notify(n: { kind: MeetingNotifyKind; title: string; body: string; meetingId: number | null }): void
  /** The meeting state changed (tray menu and tooltip). */
  recordingChanged(state: LiveMeetingState): void
}

export interface MeetingControllerDeps {
  platform: NodeJS.Platform
  settings: () => Settings
  meetings: MeetingsStore
  voiceprints: VoiceprintStore
  dictionary: () => DictionaryEntry[]
  helper: MeetingHelper
  /** userData/meetings */
  meetingsDir: string
  ui: MeetingUi
  /** Transcribe one live chunk with the live model. */
  transcribeLive: (wav: ArrayBuffer) => Promise<string>
  /** The final pass for one meeting; never throws (it marks the row ready or failed). */
  finalize: (meetingId: number) => Promise<void>
  /** The OS account name, used when `meetingUserName` is empty. */
  osUserName: () => string
  /** Diagnostic log; never given window titles, names or transcript text. */
  log: (message: string) => void
  now?: () => number
  uuid?: () => string
  session?: Partial<MeetingSessionConfig>
  /** The user's calendar, asked for the meeting's attendees when a recording starts. */
  calendar?: {
    participants(
      meeting: { app: MeetingAppId; title: string | null; startedAt: number },
      self: { name: string; email: string },
      opts?: { refresh?: boolean }
    ): Promise<MeetingParticipant[] | null>
  }
}

interface Active {
  id: number
  uuid: string
  dir: string
  key: string
  candidate: MeetingCandidate
  app: MeetingAppId
  title: string | null
  startedAt: number
  live: LiveTranscriber
  liveTimer: ReturnType<typeof setInterval>
  hintCounts: Map<string, number>
  samples: number
  mic: number
  others: number
  lastLevelsEmit: number
  /** The meeting app still holds a mic session (it releases it on mute, for some apps). */
  micHeld: boolean
  /** The user paused the mic (pill, tray, dashboard). */
  userPaused: boolean
  /** The meeting app released the mic, so the user is muted there. */
  autoPaused: boolean
  /** What the helper was last told: the mic channel records silence. */
  micPaused: boolean
  micPauses: MicPauseSpan[]
}

function describeError(e: unknown): string {
  const err = e as { name?: string; code?: string; status?: number }
  return [err?.name ?? 'Error', err?.code, err?.status].filter(Boolean).join(' ')
}

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export class MeetingController {
  private readonly now: () => number
  private readonly uuid: () => string
  private session: MeetingSession
  private enabled = false
  private unsubscribe: Array<() => void> = []
  private sessions: MicSession[] = []
  private loopTimer: ReturnType<typeof setTimeout> | null = null
  private ticking = false
  private rerun = false
  private chain: Promise<void> = Promise.resolve()
  private active: Active | null = null
  private finalQueue: number[] = []
  private finalRunning: number | null = null
  private stopRetention: (() => void) | null = null
  private shutDown = false
  /** The waiting (pending) meeting the pill shows as detected. */
  private detected: {
    key: string
    candidate: MeetingCandidate
    /** The far end was heard: the recording starts within seconds, so no "detected" notification. */
    heard: boolean
    timer: ReturnType<typeof setTimeout>
  } | null = null
  /** Keys of the candidates in the latest detector snapshot. */
  private presentKeys = new Set<string>()
  /** The recording that just ended, shown briefly as saved or discarded. */
  private ended: {
    id: number
    app: MeetingAppId
    title: string | null
    startedAt: number
    outcome: 'saved' | 'discarded'
    timer: ReturnType<typeof setTimeout>
  } | null = null
  private lastPresence = ''

  constructor(private readonly deps: MeetingControllerDeps) {
    this.now = deps.now ?? Date.now
    this.uuid = deps.uuid ?? randomUUID
    this.session = new MeetingSession(deps.session)
  }

  /** Recover interrupted meetings, start retention, and enable detection per the current settings. */
  start(): void {
    this.recover()
    this.stopRetention = scheduleRetention({
      meetings: this.deps.meetings,
      meetingsDir: this.deps.meetingsDir,
      retainDays: () => this.deps.settings().meetingRetainAudioDays,
      log: this.deps.log
    })
    this.applySettings(this.deps.settings())
  }

  /** Settings changed: turn detection on or off (a recording in progress stops as 'disabled'). */
  applySettings(s: Settings): void {
    if (this.shutDown) return
    const want = this.deps.platform === 'win32' && s.meetingMode === 'auto'
    if (want && !this.enabled) {
      this.enabled = true
      this.session = new MeetingSession(this.deps.session)
      for (const off of this.unsubscribe.splice(0)) off() // a quick off/on before the off finished
      this.unsubscribe = [
        this.deps.helper.onMicSessions((sessions) => this.onMicSessions(sessions)),
        this.deps.helper.onLevels((levels) => {
          const a = this.active
          if (!a || levels.id !== a.uuid) return
          a.mic = levels.mic
          a.others = levels.others
          a.samples = Math.max(a.samples, levels.samples)
          const now = this.now()
          if (now - a.lastLevelsEmit >= LEVELS_EMIT_MS) {
            a.lastLevelsEmit = now
            this.deps.ui.emit({ type: 'live', state: this.live() })
          }
        }),
        this.deps.helper.onWarning((w) => this.deps.log(`recording warning: ${w.code}`))
      ]
      this.deps.helper.start()
      this.deps.log('meeting detection on')
    } else if (!want && this.enabled) {
      this.enabled = false
      this.clearLoop()
      this.sessions = []
      const session = this.session
      void this.run(() => this.apply(session.setConfig(this.now(), { enabled: false }))).then(() => {
        this.updateDetected()
        if (this.enabled) return // turned back on meanwhile
        for (const off of this.unsubscribe.splice(0)) off()
        this.deps.helper.stop()
        this.deps.log('meeting detection off')
      })
    }
  }

  /** The live state for the pill, the dashboard banner and the tray. */
  live(): LiveMeetingState {
    const a = this.active
    if (a) {
      return {
        phase: 'recording',
        ended: null,
        recording: true,
        meetingId: a.id,
        app: a.app,
        title: a.title,
        startedAt: a.startedAt,
        mic: a.mic,
        others: a.others,
        micPaused: a.micPaused
      }
    }
    const idle = { ended: null, recording: false, meetingId: null, startedAt: null, mic: 0, others: 0, micPaused: false }
    if (this.detected) {
      return { ...idle, phase: 'detected', app: this.detected.candidate.app, title: this.detected.candidate.title }
    }
    const e = this.ended
    if (e) {
      return {
        ...idle,
        phase: 'ended',
        ended: e.outcome,
        meetingId: e.outcome === 'saved' ? e.id : null,
        app: e.app,
        title: e.title,
        startedAt: e.startedAt
      }
    }
    return { ...idle, phase: 'idle', app: null, title: null }
  }

  /** "Record now" on a detected meeting: start without waiting for the call to begin. */
  startNow(): Promise<void> {
    return this.run(async () => {
      await this.apply(this.session.startNow(this.now()))
      this.updateDetected()
    })
  }

  /**
   * The user pauses (records silence) or resumes their mic. Resuming also overrides a pause that
   * the meeting app's mute caused, until the app releases the mic again.
   */
  setMicPaused(paused: boolean): Promise<void> {
    return this.run(async () => {
      const a = this.active
      if (!a) return
      if (paused) a.userPaused = true
      else {
        a.userPaused = false
        a.autoPaused = false
      }
      await this.applyMicPause(a, 'user')
    })
  }

  /**
   * User Stop (pill, tray, dashboard): stop and process; the same call will not restart. On a
   * detected meeting this is "Don't record": the waiting call is suppressed until it goes away.
   */
  stop(): Promise<void> {
    return this.run(async () => {
      await this.apply(this.session.stopByUser(this.now(), false))
      this.updateDetected()
    })
  }

  /** User Discard: stop and delete the recording without processing. */
  discard(): Promise<void> {
    return this.run(async () => {
      await this.apply(this.session.stopByUser(this.now(), true))
      this.updateDetected()
    })
  }

  /** Re-run the final pass from the retained audio. */
  async reprocess(id: number): Promise<void> {
    const rec = this.deps.meetings.get(id)
    if (!rec) throw new Error('Meeting not found')
    if (rec.status === 'recording') throw new Error('The meeting is still being recorded')
    if (this.finalRunning === id || this.finalQueue.includes(id)) return
    if (!rec.audio_dir || !existsSync(rec.audio_dir)) throw new Error(AUDIO_DELETED_ERROR)
    this.deps.meetings.update(id, { status: 'processing', progress: 'Queued', error: null })
    this.updated(id)
    this.enqueueFinal(id)
  }

  /** Delete a meeting, its audio and its stored voices. The .md in the output folder stays. */
  async remove(id: number): Promise<void> {
    if (this.active?.id === id) {
      await this.discard()
      return
    }
    const rec = this.deps.meetings.get(id)
    if (!rec) return
    this.finalQueue = this.finalQueue.filter((q) => q !== id)
    this.deps.meetings.delete(id)
    if (rec.audio_dir && inside(this.deps.meetingsDir, rec.audio_dir)) rmSync(rec.audio_dir, { recursive: true, force: true })
    rmSync(speakersFilePath(this.deps.meetingsDir, rec.uuid), { force: true })
    this.updated(id)
  }

  /**
   * Name a speaker. With `remember`, a speaker with ≥ 10 s of stored voice is enrolled so future
   * meetings recognise them. Notes owners follow the relabel, and a written .md is re-rendered.
   */
  renameSpeaker(id: number, key: SpeakerKey, name: string, remember: boolean): MeetingDetail | null {
    const rec = this.deps.meetings.get(id)
    if (!rec) return null
    const label = name.trim()
    if (!label) throw new Error('A speaker needs a name')
    let personId: number | null = null
    if (remember && key !== SELF_SPEAKER_KEY) {
      const voices = readSpeakersFile(this.deps.meetingsDir, rec.uuid)
      const voice = voices?.speakers.find((s) => s.key === key)
      if (voices?.embeddingModel && voice?.embedding && voice.seconds >= 10) {
        const person = this.deps.voiceprints.ensurePerson(label)
        this.deps.voiceprints.addExemplar(person.id, {
          embedding: voice.embedding,
          model: voices.embeddingModel,
          seconds: voice.seconds,
          sourceApp: rec.app
        })
        personId = person.id
      } else {
        this.deps.log(`rename: meeting ${id} speaker has no stored voice of 10 s or more; named but not remembered`)
      }
    }
    const speakers = renameSpeaker(rec.speakers, key, label, personId)
    const notes = rec.notes ? relabelOwners(rec.notes, rec.speakers, speakers) : null
    let updated = this.deps.meetings.update(id, { speakers, notes })!
    if (updated.output_path && updated.status === 'ready') {
      try {
        const path = writeMeetingMarkdown(updated, this.deps.meetings.segments(id), dirname(updated.output_path))
        if (path !== updated.output_path) updated = this.deps.meetings.update(id, { output_path: path })!
      } catch (e) {
        this.deps.log(`rename: could not rewrite the .md (${describeError(e)})`)
      }
    }
    this.updated(id)
    return { ...updated, segments: this.deps.meetings.segments(id) }
  }

  /**
   * Quit: stop a recording cleanly (its row goes to `processing`, so the next launch finalises
   * it) and shut the helper down. Live transcription and any running final pass are abandoned.
   */
  async shutdown(): Promise<void> {
    if (this.shutDown) return
    this.shutDown = true
    this.enabled = false
    this.clearLoop()
    this.stopRetention?.()
    for (const off of this.unsubscribe.splice(0)) off()
    const a = this.active
    this.active = null
    if (a) {
      clearInterval(a.liveTimer)
      a.live.cancel()
      let samples = a.samples
      try {
        const stopped = await Promise.race([
          this.deps.helper.stopRecording(a.uuid),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), SHUTDOWN_STOP_TIMEOUT_MS))
        ])
        samples = stopped.samples
      } catch (e) {
        this.deps.log(`quit: record-stop failed (${describeError(e)}); the helper finishes the files on exit`)
      }
      this.deps.meetings.update(a.id, { status: 'processing', ended_at: this.endedAt(a, samples), progress: null })
      this.deps.log(`quit: meeting ${a.id} left for the next launch to finish`)
    }
    if (this.detected) clearTimeout(this.detected.timer)
    if (this.ended) clearTimeout(this.ended.timer)
    this.detected = null
    this.ended = null
    this.emitLive()
    this.deps.helper.stop()
  }

  /** True while a recording is in progress (quit needs to stop it first). */
  get recording(): boolean {
    return this.active !== null
  }

  // ── detection loop ────────────────────────────────────────────────────────────

  private onMicSessions(sessions: MicSession[]): void {
    if (!this.enabled) return
    this.sessions = sessions
    // Pause the user's mic at once when the meeting app releases it (muted), before any probing.
    if (this.active) void this.run(() => this.followAppMic())
    if (this.ticking) {
      this.rerun = true
      return
    }
    this.clearLoop()
    void this.tick()
  }

  private async tick(): Promise<void> {
    this.ticking = true
    let exes: string[] = []
    try {
      const apps = this.deps.settings().meetingApps
      exes = probeExesFor(this.sessions, apps)
      // Never probe (read window titles or tabs) unless an enabled meeting app holds the mic, or a
      // call is being recorded or was just stopped by the user: an app that releases the mic on
      // mute still needs its evidence checked, so the recording goes on and a stopped call stays
      // stopped.
      const watched = this.session.watched()
      const probeExes = [...new Set([...exes, ...watched.flatMap((c) => candidateExes(c))])]
      let probe: ProbeResult | null = null
      if (probeExes.length > 0) {
        try {
          probe = await this.deps.helper.probe(probeExes)
        } catch (e) {
          this.deps.log(`probe failed (${describeError(e)})`)
        }
      }
      if (!this.enabled) return
      const candidates = detectMeetings(this.sessions, probe, apps)
      const actions = this.session.observe(this.now(), candidates, (c) => continuationEvidence(c, probe))
      this.presentKeys = new Set(candidates.map((c) => c.key))
      await this.run(async () => {
        await this.apply(actions)
        this.countHints(candidates)
        this.updateDetected()
      })
    } catch (e) {
      this.deps.log(`detection failed (${describeError(e)})`)
    } finally {
      this.ticking = false
      if (this.enabled) {
        if (this.rerun) {
          this.rerun = false
          this.schedule(0)
        } else if (exes.length > 0 || this.session.state !== 'idle' || this.session.watched().length > 0) {
          // A pending candidate, an ending recording or a stopped call needs observations to
          // advance its timers.
          this.schedule(this.active ? PROBE_EVERY_RECORDING_MS : PROBE_EVERY_MS)
        }
      }
    }
  }

  private schedule(ms: number): void {
    this.clearLoop()
    this.loopTimer = setTimeout(() => {
      this.loopTimer = null
      void this.tick()
    }, ms)
  }

  private clearLoop(): void {
    if (this.loopTimer) clearTimeout(this.loopTimer)
    this.loopTimer = null
  }

  /** Serialise everything that changes recording state. */
  private run(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work).catch((e) => this.deps.log(`meeting action failed (${describeError(e)})`))
    this.chain = next
    return next
  }

  private async apply(actions: MeetingSessionAction[]): Promise<void> {
    for (const action of actions) {
      if (action.type === 'start') await this.startRecording(action.candidate)
      else if (action.type === 'update') this.updateCandidate(action.candidate)
      else if (action.type === 'retarget') {
        if (this.active) this.deps.helper.retarget(this.active.uuid, action.otherPids)
      } else await this.stopRecording(action.reason)
    }
  }

  // ── actions ───────────────────────────────────────────────────────────────────

  private userName(): string {
    return this.deps.settings().meetingUserName.trim() || this.deps.osUserName()
  }

  /** The recorded app releasing (muting) or retaking the mic pauses or resumes the mic channel. */
  private async followAppMic(): Promise<void> {
    const a = this.active
    if (!a) return
    const exes = a.candidate.viaBrowser ? [] : candidateExes(a.candidate)
    const held = this.sessions.some((s) => s.appPid === a.candidate.appPid || exes.includes(s.exe.toLowerCase()))
    if (held === a.micHeld) return
    a.micHeld = held
    a.autoPaused = !held
    await this.applyMicPause(a, 'app')
  }

  /**
   * Tell the helper to record silence (or the mic again) and keep the span next to the audio, so
   * the live and final passes silence it too, with the moment before it. A pause the helper could
   * not confirm still counts, at the position the clock gives.
   */
  private async applyMicPause(a: Active, by: 'user' | 'app'): Promise<void> {
    const paused = a.userPaused || a.autoPaused
    if (paused === a.micPaused) return
    a.micPaused = paused
    let at = Math.max(0, Math.round(((this.now() - a.startedAt) * MEETING_SAMPLE_RATE) / 1000))
    try {
      at = (await this.deps.helper.setMicPaused(a.uuid, paused)).samples
    } catch (e) {
      this.deps.log(`mic ${paused ? 'pause' : 'resume'} not confirmed by the helper (${describeError(e)})`)
    }
    const open = a.micPauses.at(-1)
    if (paused) a.micPauses.push({ from: at, to: null })
    else if (open && open.to === null) open.to = Math.max(open.from, at)
    try {
      writeMicPauses(a.dir, a.micPauses)
    } catch (e) {
      this.deps.log(`could not save the mic pauses (${describeError(e)})`)
    }
    a.live.setMicPaused(paused, at)
    this.deps.log(`mic ${paused ? 'paused' : 'resumed'} (${by}): meeting ${a.id}`)
    if (this.active === a) this.emitLive()
  }

  private async startRecording(candidate: MeetingCandidate): Promise<void> {
    const uuid = this.uuid()
    const dir = join(this.deps.meetingsDir, uuid)
    mkdirSync(dir, { recursive: true })
    const hints = [...new Set(candidate.nameHints)]
    const row = this.deps.meetings.create({
      uuid,
      started_at: this.now(),
      app: candidate.app,
      title: candidate.title,
      audio_dir: dir,
      name_hints: hints
    })
    this.deps.meetings.update(row.id, { speakers: liveSpeakers(this.userName(), hints) })
    const label = MEETING_APP_LABELS[candidate.app]

    let started
    try {
      started = await this.deps.helper.startRecording({
        id: uuid,
        dir,
        otherPids: candidate.otherPids,
        micEndpointId: candidate.micEndpointId
      })
    } catch (e) {
      this.deps.log(`recording failed to start: meeting ${row.id} (${describeError(e)})`)
      rmSync(dir, { recursive: true, force: true })
      const reason = `Couldn't start recording: ${(e as Error).message ?? 'unknown error'}`.slice(0, 200)
      this.deps.meetings.update(row.id, { status: 'failed', error: reason, ended_at: this.now(), audio_dir: null })
      // Treat it like a user stop, so this call does not retry in a loop.
      this.session.stopByUser(this.now(), false)
      this.updated(row.id)
      this.deps.ui.notify({ kind: 'record-failed', title: `Echo couldn't record ${label}`, body: reason, meetingId: row.id })
      return
    }

    if (this.shutDown) {
      // Echo is quitting: stop at once and leave the meeting for the next launch to finish.
      await this.deps.helper.stopRecording(uuid).catch(() => undefined)
      this.deps.meetings.update(row.id, { status: 'processing', started_at: started.startedAt, ended_at: this.now() })
      return
    }
    this.deps.meetings.update(row.id, { started_at: started.startedAt })
    const live = new LiveTranscriber({
      mic: new PcmTail(join(dir, 'mic.pcm')),
      others: new PcmTail(join(dir, 'others.pcm')),
      transcribe: this.deps.transcribeLive,
      dictionary: this.deps.dictionary,
      append: (segment) => this.deps.meetings.appendSegment(row.id, segment),
      onSegment: (segment) => this.deps.ui.emit({ type: 'segment', meetingId: row.id, segment }),
      log: this.deps.log
    })
    const hintCounts = new Map<string, number>()
    for (const h of hints) hintCounts.set(h, 1)
    this.active = {
      id: row.id,
      uuid,
      dir,
      key: candidate.key,
      candidate,
      app: candidate.app,
      title: candidate.title,
      startedAt: started.startedAt,
      live,
      liveTimer: setInterval(() => {
        try {
          live.tick()
        } catch (e) {
          this.deps.log(`live transcript failed (${describeError(e)})`)
        }
      }, LIVE_EVERY_MS),
      hintCounts,
      samples: 0,
      mic: 0,
      others: 0,
      lastLevelsEmit: 0,
      micHeld: true,
      userPaused: false,
      autoPaused: false,
      micPaused: false,
      micPauses: []
    }
    this.deps.log(`recording started: meeting ${row.id} (${candidate.app}, others ${started.othersMode})`)
    // Who attended, from the calendar (refreshed now); the final pass names speakers with it.
    void this.deps.calendar
      ?.participants(
        { app: candidate.app, title: candidate.title, startedAt: started.startedAt },
        { name: this.userName(), email: this.deps.settings().meetingMyEmail },
        { refresh: true }
      )
      .then((people) => {
        if (people?.length && this.deps.meetings.update(row.id, { participants: people })) this.updated(row.id)
      })
    this.updateDetected()
    this.updated(row.id)
    this.deps.ui.notify({ kind: 'started', title: `Recording started: ${label}`, body: STARTED_BODY, meetingId: row.id })
  }

  private updateCandidate(candidate: MeetingCandidate): void {
    const a = this.active
    if (!a || candidate.key !== a.key) return
    a.candidate = candidate
    // Keep the last real title: a window that briefly shows no meeting name should not erase it.
    if (candidate.title && candidate.title !== a.title) {
      a.title = candidate.title
      this.deps.meetings.update(a.id, { title: candidate.title })
      this.emitLive()
      this.updated(a.id)
    }
  }

  /** Accumulate the name hints seen while recording; stored distinct, most frequent first. */
  private countHints(candidates: MeetingCandidate[]): void {
    const a = this.active
    if (!a) return
    const seen = candidates.find((c) => c.key === a.key)
    if (!seen || seen.nameHints.length === 0) return
    const before = ordered(a.hintCounts)
    for (const h of new Set(seen.nameHints)) a.hintCounts.set(h, (a.hintCounts.get(h) ?? 0) + 1)
    const after = ordered(a.hintCounts)
    if (after.join('\n') === before.join('\n')) return
    this.deps.meetings.update(a.id, { name_hints: after, speakers: liveSpeakers(this.userName(), after) })
    this.updated(a.id)
  }

  private async stopRecording(reason: MeetingStopReason): Promise<void> {
    const a = this.active
    if (!a) return
    this.active = null
    // A call that ended keeps only what was recorded while it was evidently live.
    const liveUntil = reason === 'ended' ? this.session.lastLiveAt : null
    clearInterval(a.liveTimer)
    if (reason === 'discard') a.live.cancel()
    let samples = a.samples
    try {
      samples = (await this.deps.helper.stopRecording(a.uuid)).samples
    } catch (e) {
      this.deps.log(`record-stop failed: meeting ${a.id} (${describeError(e)}); using the files as written`)
      samples = Math.max(samples, pcmSampleCount(join(a.dir, 'mic.pcm')), pcmSampleCount(join(a.dir, 'others.pcm')))
    }
    const recorded = samples
    if (liveUntil !== null && reason !== 'discard') {
      // The call ended between the last observation that showed it and the next one: keep that
      // one probe interval, so a last "bye" said just before hanging up survives.
      const keep = Math.max(0, Math.round(((liveUntil + PROBE_EVERY_RECORDING_MS - a.startedAt) * MEETING_SAMPLE_RATE) / 1000))
      if (keep < samples) {
        samples = keep
        a.live.endAt(keep)
        for (const file of ['mic.pcm', 'others.pcm']) {
          try {
            truncateSync(join(a.dir, file), keep * 2)
          } catch {
            /* missing file: nothing to trim */
          }
        }
        this.deps.log(`recording trimmed ${Math.round((recorded - keep) / MEETING_SAMPLE_RATE)} s recorded after the meeting ended: meeting ${a.id}`)
      }
    }
    const seconds = Math.round(samples / MEETING_SAMPLE_RATE)
    this.deps.log(`recording stopped: meeting ${a.id} (${reason}, ${seconds} s)`)
    this.showEnded(a, reason === 'discard' ? 'discarded' : 'saved')
    if (reason !== 'discard') {
      const minutes = Math.max(1, Math.round(seconds / 60))
      this.deps.ui.notify({
        kind: 'ended',
        title: `Recording ended: ${MEETING_APP_LABELS[a.app]} · ${minutes} min`,
        body: ENDED_BODY,
        meetingId: a.id
      })
    }

    if (reason === 'discard') {
      this.deps.meetings.delete(a.id)
      rmSync(a.dir, { recursive: true, force: true })
      this.updated(a.id)
      return
    }
    this.deps.meetings.update(a.id, {
      status: 'processing',
      ended_at: samples < recorded ? a.startedAt + Math.round((samples * 1000) / MEETING_SAMPLE_RATE) : this.endedAt(a, samples),
      progress: 'Finishing the live transcript'
    })
    this.updated(a.id)
    // The final chunk of the live transcript lands before the final pass replaces it.
    const endMs = Math.round((samples * 1000) / MEETING_SAMPLE_RATE)
    void a.live
      .flush()
      .catch((e) => this.deps.log(`live flush failed (${describeError(e)})`))
      .then(() => {
        if (samples < recorded) this.deps.meetings.deleteSegmentsAfter(a.id, endMs)
        this.enqueueFinal(a.id)
      })
  }

  private endedAt(a: Active, samples: number): number {
    return samples > 0 ? a.startedAt + Math.round((samples * 1000) / MEETING_SAMPLE_RATE) : this.now()
  }

  // ── final pass queue and recovery ─────────────────────────────────────────────

  private enqueueFinal(id: number): void {
    if (this.shutDown || this.finalRunning === id || this.finalQueue.includes(id)) return
    this.finalQueue.push(id)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.finalRunning !== null) return
    while (this.finalQueue.length > 0 && !this.shutDown) {
      const id = this.finalQueue.shift()!
      this.finalRunning = id
      try {
        await this.deps.finalize(id)
      } catch (e) {
        this.deps.log(`final pass crashed: meeting ${id} (${describeError(e)})`)
      } finally {
        this.finalRunning = null
      }
    }
  }

  /** Meetings a crash or quit interrupted: finish recordings from their files, resume processing. */
  private recover(): void {
    for (const rec of this.deps.meetings.byStatus(['recording'])) {
      const samples = rec.audio_dir
        ? Math.max(pcmSampleCount(join(rec.audio_dir, 'mic.pcm')), pcmSampleCount(join(rec.audio_dir, 'others.pcm')))
        : 0
      const endedAt = rec.ended_at ?? rec.started_at + Math.round((samples * 1000) / MEETING_SAMPLE_RATE)
      this.deps.meetings.update(rec.id, { status: 'processing', ended_at: endedAt, progress: 'Queued' })
      this.deps.log(`recovered: meeting ${rec.id} was recording when Echo stopped (${Math.round(samples / MEETING_SAMPLE_RATE)} s saved)`)
    }
    const processing = this.deps.meetings.byStatus(['processing']).sort((a, b) => a.started_at - b.started_at || a.id - b.id)
    for (const rec of processing) this.enqueueFinal(rec.id)
  }

  /** The pill confirms how the recording ended for a few seconds, then hides. */
  private showEnded(a: Active, outcome: 'saved' | 'discarded'): void {
    if (this.ended) clearTimeout(this.ended.timer)
    const timer = setTimeout(() => {
      if (this.ended?.timer !== timer) return
      this.ended = null
      this.emitLive()
    }, outcome === 'saved' ? SAVED_SHOWN_MS : DISCARDED_SHOWN_MS)
    this.ended = { id: a.id, app: a.app, title: a.title, startedAt: a.startedAt, outcome, timer }
    this.emitLive()
  }

  /**
   * Follow the session's waiting (pending) meeting: the pill shows it as detected, and if it is
   * still waiting a few seconds later a notification says so (a live call starts sooner, and then
   * only the start is announced). A waiting meeting that goes away just hides the pill.
   */
  private updateDetected(): void {
    const pending = this.enabled && !this.shutDown && !this.active && this.session.state === 'pending' ? this.session.current : null
    if (!pending) {
      if (this.detected) clearTimeout(this.detected.timer)
      this.detected = null
    } else if (this.detected?.key === pending.key) {
      this.detected.candidate = pending
      this.detected.heard ||= pending.remoteAudio && this.presentKeys.has(pending.key)
    } else {
      if (this.detected) clearTimeout(this.detected.timer)
      const key = pending.key
      const timer = setTimeout(() => {
        const d = this.detected
        // Only a meeting still on screen and still waiting for the call to begin is announced.
        if (!d || d.key !== key || this.active || d.heard || !this.presentKeys.has(key)) return
        this.deps.ui.notify({
          kind: 'detected',
          title: `Meeting detected: ${MEETING_APP_LABELS[d.candidate.app]}`,
          body: 'Echo starts transcribing when the call begins. Use the pill to record now or skip this meeting.',
          meetingId: null
        })
      }, DETECTED_NOTIFY_MS)
      this.detected = { key, candidate: pending, heard: pending.remoteAudio, timer }
      if (this.ended) clearTimeout(this.ended.timer)
      this.ended = null
      this.deps.log(`meeting detected (${pending.app})`)
    }
    this.emitLive()
  }

  /** Tell the dashboard, the overlay and the tray when the meeting state changes. */
  private emitLive(): void {
    const state = this.live()
    const presence = [state.phase, state.ended, state.meetingId, state.app, state.title, state.micPaused].join('|')
    if (presence === this.lastPresence) return
    this.lastPresence = presence
    this.deps.ui.emit({ type: 'live', state })
    this.deps.ui.recordingChanged(state)
  }

  private updated(meetingId: number): void {
    this.deps.ui.emit({ type: 'updated', meetingId })
  }
}

function ordered(counts: Map<string, number>): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h)
}

/** Action-item owners are speaker labels; keep them pointing at the same speaker after a relabel. */
function relabelOwners(
  notes: NonNullable<MeetingDetail['notes']>,
  before: MeetingSpeaker[],
  after: MeetingSpeaker[]
): NonNullable<MeetingDetail['notes']> {
  const next = new Map(after.map((s) => [s.key, s.label]))
  const map = new Map<string, string>()
  for (const s of before) {
    const label = next.get(s.key)
    if (label !== undefined && label !== s.label) map.set(s.label, label)
  }
  if (map.size === 0) return notes
  return {
    ...notes,
    actionItems: notes.actionItems.map((i) => (i.owner && map.has(i.owner) ? { ...i, owner: map.get(i.owner)! } : i))
  }
}
