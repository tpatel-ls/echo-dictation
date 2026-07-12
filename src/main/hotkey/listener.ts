import { app } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { HotkeyMachine, type MachineOptions } from './machine'
import type { TriggerKey } from '@shared/types'
import { helperPath } from '../native/helper-path'
import { NativeHelperSupervisor, type SupervisedProcess } from '../native/helper-supervisor'

export interface HotkeyCallbacks {
  onStart: () => void
  onStop: (durationMs: number) => void
  onCancel: (reason: 'too-short' | 'other-key') => void
}

interface HotkeyHelperStream {
  setEncoding(encoding: BufferEncoding): void
  on(event: 'data', listener: (chunk: string) => void): unknown
}

export interface HotkeyHelperProcess extends SupervisedProcess {
  stdout?: HotkeyHelperStream | null
  stderr?: HotkeyHelperStream | null
}

export interface HotkeyListenerDeps {
  exists(path: string): boolean
  helperPath(): string
  spawn(path: string): HotkeyHelperProcess
}

interface NativeKeyEvent {
  type: 'key'
  key: 'leftOption' | 'rightOption' | 'leftControl' | 'rightControl' | 'capsLock' | 'f8'
  down: boolean
  anyOption?: boolean
}

interface NativeReadyEvent {
  type: 'ready'
}

interface NativeErrorEvent {
  type: 'error'
  message: string
}

/**
 * Bridges the global low-level keyboard hook to the pure HotkeyMachine and fires
 * dictation callbacks. Distinguishes the configured trigger key from every other key.
 */
export class HotkeyListener {
  private machine: HotkeyMachine
  private supervisor: NativeHelperSupervisor | null = null
  private stdout = ''

  constructor(
    opts: MachineOptions,
    private triggerKey: TriggerKey,
    private cb: HotkeyCallbacks,
    private deps: HotkeyListenerDeps = defaultHotkeyDeps
  ) {
    this.machine = new HotkeyMachine(opts)
  }

  get isRunning(): boolean {
    return this.supervisor?.isRunning ?? false
  }

  start(): void {
    if (this.supervisor) {
      this.supervisor.start()
      return
    }
    const helper = this.deps.helperPath()
    if (!this.deps.exists(helper)) throw new Error(`Keyboard helper is not built at ${helper}`)
    this.supervisor = new NativeHelperSupervisor({
      spawn: () => this.deps.spawn(helper),
      maxRestarts: 4,
      baseDelayMs: 250,
      onProcess: (process) => this.attachProcess(process as HotkeyHelperProcess, helper),
      onCrash: ({ error, code, signal, restartAttempt }) => {
        const detail = error?.message ?? `code=${code ?? 'signal'} signal=${signal ?? 'none'}`
        diagnosticLog(`helper crash ${detail}; restart=${restartAttempt + 1}`)
      },
      onExhausted: ({ error, code }) => {
        const detail = error?.message ?? `exit code ${code ?? 'signal'}`
        console.error(`[echo] key helper recovery exhausted: ${detail}`)
        diagnosticLog(`helper recovery exhausted: ${detail}`)
      }
    })
    this.supervisor.start()
  }

  private attachProcess(child: HotkeyHelperProcess, helper: string): void {
    this.stdout = ''
    diagnosticLog(`starting helper ${helper}; trigger=${this.triggerKey}`)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', this.onStdout)
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) {
        console.error('[echo] key helper:', text)
        diagnosticLog(`helper stderr: ${text}`)
      }
    })
  }

  stop(): void {
    this.supervisor?.stop()
  }

  update(opts: MachineOptions, triggerKey: TriggerKey): void {
    this.triggerKey = triggerKey
    this.machine.setOptions(opts)
  }

  private onStdout = (chunk: string): void => {
    this.stdout += chunk
    const lines = this.stdout.split(/\r?\n/)
    this.stdout = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as NativeKeyEvent | NativeReadyEvent | NativeErrorEvent
        if (event.type === 'key') this.onNativeKey(event)
        else if (event.type === 'ready') this.supervisor?.markHealthy()
        else if (event.type === 'error') console.error('[echo] key helper:', event.message)
      } catch {
        console.error('[echo] key helper produced invalid JSON')
      }
    }
  }

  private onNativeKey(event: NativeKeyEvent): void {
    const matched = matchesTrigger(this.triggerKey, event)
    diagnosticLog(`native key=${event.key} down=${event.down} trigger=${this.triggerKey} matched=${matched}`)
    if (!matched) return
    const type = event.down ? 'trigger-down' : 'trigger-up'
    this.dispatch(this.machine.handle({ type, t: Date.now() }))
  }

  private dispatch(cmd: ReturnType<HotkeyMachine['handle']>): void {
    if (!cmd) return
    diagnosticLog(`command=${cmd.type}${cmd.type === 'stop' ? ` duration=${cmd.durationMs}` : ''}`)
    if (cmd.type === 'start') this.cb.onStart()
    else if (cmd.type === 'stop') this.cb.onStop(cmd.durationMs)
    else if (cmd.type === 'cancel') this.cb.onCancel(cmd.reason)
  }
}

function matchesTrigger(triggerKey: TriggerKey, event: NativeKeyEvent): boolean {
  if (triggerKey === 'EitherOption') return true
  if (triggerKey === 'LeftOption') return event.key === 'leftOption'
  if (triggerKey === 'RightOption') return event.key === 'rightOption'
  if (triggerKey === 'LeftControl') return event.key === 'leftControl'
  if (triggerKey === 'RightControl') return event.key === 'rightControl'
  if (triggerKey === 'CapsLock') return event.key === 'capsLock'
  if (triggerKey === 'F8') return event.key === 'f8'
  return false
}

function nativeHelperPath(name: string): string {
  return helperPath(
    name as 'EchoKeyHelper',
    process.platform,
    app.isPackaged ? process.resourcesPath : undefined,
    process.cwd()
  )
}

const defaultHotkeyDeps: HotkeyListenerDeps = {
  exists: existsSync,
  helperPath: () => nativeHelperPath('EchoKeyHelper'),
  spawn: (path) => spawn(path, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }) as HotkeyHelperProcess
}

function diagnosticLog(message: string): void {
  try {
    const file = join(app.getPath('userData'), 'hotkey.log')
    if (existsSync(file) && statSync(file).size > 64 * 1024) truncateSync(file, 0)
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* Diagnostics must never affect dictation. */
  }
}
