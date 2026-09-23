// Main-process side of EchoMeetingHelper.exe: spawns it under the native-helper supervisor,
// splits its stdout into protocol lines, fans out mic-session snapshots, levels and warnings, and
// matches request replies by id. Windows only; everywhere else start() is a no-op.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type {
  HelperLine,
  HelperRequest,
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
import { helperPath } from '../native/helper-path'
import { NativeHelperSupervisor, type SupervisedProcess } from '../native/helper-supervisor'
import { parseHelperLine, serializeHelperRequest } from './helper-protocol'

interface HelperStream {
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown
}

export interface MeetingHelperProcess extends SupervisedProcess {
  stdout: HelperStream | null
  stderr?: HelperStream | null
  stdin: {
    write(chunk: string): unknown
    end(): unknown
  } | null
}

export interface MeetingHelperClientOptions {
  platform?: NodeJS.Platform
  resourcesPath?: string
  cwd?: string
  echoPid?: number // default process.pid
  requestTimeoutMs?: number // default 5000 (probe, record-start, record-stop)
  requestId?: () => string
  spawnHelper?: (path: string, args: string[]) => MeetingHelperProcess // test seam
  /** Test seam for "is the helper built?"; defaults to fs.existsSync. */
  exists?: (path: string) => boolean
  log?: (message: string) => void
}

/** A request the helper refused: `code` is the helper's error code (e.g. 'busy', 'not-recording'). */
export class MeetingHelperError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'MeetingHelperError'
  }
}

type ReplyType = 'probe-result' | 'record-started' | 'record-stopped' | 'record-mic-paused'

interface Pending {
  id: string
  reply: ReplyType
  resolve: (line: HelperLine) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 5000
const SHUTDOWN_GRACE_MS = 3000

export class MeetingHelperClient implements MeetingHelper {
  private supervisor: NativeHelperSupervisor | null = null
  private child: MeetingHelperProcess | null = null
  private ready = false
  private buffer = ''
  private nextId = 0
  private pending: Pending[] = []
  private readonly sessionListeners = new Set<(sessions: MicSession[]) => void>()
  private readonly levelListeners = new Set<(levels: RecordLevels) => void>()
  private readonly warningListeners = new Set<(warning: RecordWarning) => void>()

  constructor(private readonly opts: MeetingHelperClientOptions = {}) {}

  get available(): boolean {
    return this.ready
  }

  start(): void {
    const platform = this.opts.platform ?? process.platform
    if (platform !== 'win32') return
    if (!this.supervisor) {
      const path = helperPath('EchoMeetingHelper', platform, this.opts.resourcesPath, this.opts.cwd)
      if (!(this.opts.exists ?? existsSync)(path)) {
        this.log(`meeting helper is not built at ${path}`)
        return
      }
      const args = ['--server', '--echo-pid', String(this.opts.echoPid ?? process.pid)]
      const spawnHelper = this.opts.spawnHelper ?? defaultSpawnHelper
      this.supervisor = new NativeHelperSupervisor({
        spawn: () => this.supervised(spawnHelper(path, args)),
        maxRestarts: 5,
        baseDelayMs: 500,
        onCrash: ({ error, code, signal, restartAttempt }) => {
          const detail = error?.message ?? `code=${code ?? 'none'} signal=${signal ?? 'none'}`
          this.log(`meeting helper exited (${detail}); restart ${restartAttempt + 1}`)
        },
        onExhausted: () => this.log('meeting helper keeps crashing; giving up until restart')
      })
    }
    this.supervisor.start()
  }

  stop(): void {
    // The supervisor calls kill() on the wrapper, which asks the helper to shut down first.
    this.supervisor?.stop()
  }

  onMicSessions(cb: (sessions: MicSession[]) => void): () => void {
    return subscribe(this.sessionListeners, cb)
  }

  onLevels(cb: (levels: RecordLevels) => void): () => void {
    return subscribe(this.levelListeners, cb)
  }

  onWarning(cb: (warning: RecordWarning) => void): () => void {
    return subscribe(this.warningListeners, cb)
  }

  async probe(exes: string[]): Promise<ProbeResult> {
    const id = this.opts.requestId?.() ?? `p${++this.nextId}`
    const line = await this.request({ type: 'probe', id, exes }, 'probe-result')
    if (line.type !== 'probe-result') throw new Error('Unexpected reply')
    return { windows: line.windows, tabs: line.tabs, render: line.render }
  }

  async startRecording(req: RecordStartRequest): Promise<RecordStarted> {
    const line = await this.request({ type: 'record-start', ...req }, 'record-started')
    if (line.type !== 'record-started') throw new Error('Unexpected reply')
    return { id: line.id, startedAt: line.startedAt, othersMode: line.othersMode, micName: line.micName }
  }

  retarget(id: string, otherPids: number[]): void {
    if (this.ready) this.write({ type: 'record-retarget', id, otherPids })
  }

  async stopRecording(id: string): Promise<RecordStopped> {
    const line = await this.request({ type: 'record-stop', id }, 'record-stopped')
    if (line.type !== 'record-stopped') throw new Error('Unexpected reply')
    return { id: line.id, samples: line.samples }
  }

  async setMicPaused(id: string, paused: boolean): Promise<RecordMicPaused> {
    const line = await this.request({ type: 'record-mic-pause', id, paused }, 'record-mic-paused')
    if (line.type !== 'record-mic-paused') throw new Error('Unexpected reply')
    return { id: line.id, paused: line.paused, samples: line.samples }
  }

  private request(req: HelperRequest & { id: string }, reply: ReplyType): Promise<HelperLine> {
    if (!this.ready || !this.child) return Promise.reject(new Error('Meeting helper is not running'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.take((p) => p.id === req.id && p.reply === reply)) {
          reject(new Error(`Meeting helper did not answer ${req.type} in time`))
        }
      }, this.opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS)
      this.pending.push({ id: req.id, reply, resolve, reject, timer })
      try {
        this.write(req)
      } catch (error) {
        this.take((p) => p.id === req.id && p.reply === reply)
        reject(error as Error)
      }
    })
  }

  private write(req: HelperRequest): void {
    this.child?.stdin?.write(serializeHelperRequest(req))
  }

  /** Remove and return the first pending request matching `match`, clearing its timer. */
  private take(match: (pending: Pending) => boolean): Pending | null {
    const index = this.pending.findIndex(match)
    if (index === -1) return null
    const [found] = this.pending.splice(index, 1)
    clearTimeout(found!.timer)
    return found!
  }

  /** Attach a freshly spawned helper; the returned wrapper turns kill() into a graceful shutdown. */
  private supervised(child: MeetingHelperProcess): SupervisedProcess {
    this.detach(new Error('Meeting helper restarted'))
    this.child = child
    this.buffer = ''
    child.stdout?.on('data', (chunk) => {
      if (this.child === child) this.onStdout(String(chunk))
    })
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) this.log(`meeting helper stderr: ${text}`)
    })
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const gone = (): void => {
      if (killTimer) clearTimeout(killTimer)
      killTimer = null
      if (this.child === child) this.detach(new Error('Meeting helper exited'))
    }
    child.once('exit', gone)
    child.once('error', gone)

    const wrapper: SupervisedProcess = {
      kill: () => {
        if (this.child === child) this.detach(new Error('Meeting helper stopped'))
        try {
          child.stdin?.write(serializeHelperRequest({ type: 'shutdown' }))
          child.stdin?.end()
        } catch {
          /* already gone */
        }
        killTimer = setTimeout(() => {
          killTimer = null
          try {
            child.kill()
          } catch {
            /* already gone */
          }
        }, SHUTDOWN_GRACE_MS)
      },
      once(event: 'error' | 'exit', listener: (...args: never[]) => void) {
        child.once(event as 'exit', listener as never)
        return wrapper
      }
    } as SupervisedProcess
    return wrapper
  }

  /** Forget the current helper: fail everything in flight and tell detection nothing captures. */
  private detach(reason: Error): void {
    const hadChild = this.child !== null
    this.child = null
    this.ready = false
    this.buffer = ''
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    if (hadChild) this.emit(this.sessionListeners, [])
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const raw = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      const line = parseHelperLine(raw)
      if (line) this.onLine(line)
      else if (raw.trim()) this.log('meeting helper sent an unreadable line')
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: HelperLine): void {
    switch (line.type) {
      case 'ready':
        this.ready = true
        this.supervisor?.markHealthy()
        return
      case 'mic-sessions':
        this.emit(this.sessionListeners, line.sessions)
        return
      case 'record-levels': {
        const { type: _type, ...levels } = line
        this.emit(this.levelListeners, levels)
        return
      }
      case 'record-warning': {
        const { type: _type, ...warning } = line
        this.emit(this.warningListeners, warning)
        return
      }
      case 'probe-result':
      case 'record-started':
      case 'record-stopped':
      case 'record-mic-paused':
        this.take((p) => p.id === line.id && p.reply === line.type)?.resolve(line)
        return
      case 'error':
        if (line.id === undefined) this.log(`meeting helper error ${line.code}: ${line.message}`)
        else this.take((p) => p.id === line.id)?.reject(new MeetingHelperError(line.code, line.message))
        return
      case 'log':
        this.log(`meeting helper: ${line.message}`)
        return
    }
  }

  private emit<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of [...listeners]) {
      try {
        listener(value)
      } catch (error) {
        this.log(`meeting helper listener failed: ${(error as Error).message}`)
      }
    }
  }

  private log(message: string): void {
    this.opts.log?.(message)
  }
}

function subscribe<T>(listeners: Set<T>, cb: T): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function defaultSpawnHelper(path: string, args: string[]): MeetingHelperProcess {
  const child = spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  return child as unknown as MeetingHelperProcess
}
