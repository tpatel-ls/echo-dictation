import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { HotkeyMachine, type MachineOptions } from './machine'
import type { TriggerKey } from '@shared/types'
import { helperPath } from '../native/helper-path'

export interface HotkeyCallbacks {
  onStart: () => void
  onStop: (durationMs: number) => void
  onCancel: (reason: 'too-short' | 'other-key') => void
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
  private running = false
  private child: ChildProcess | null = null
  private stdout = ''

  constructor(
    opts: MachineOptions,
    private triggerKey: TriggerKey,
    private cb: HotkeyCallbacks
  ) {
    this.machine = new HotkeyMachine(opts)
  }

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    const helper = nativeHelperPath('EchoKeyHelper')
    if (!existsSync(helper)) throw new Error(`Keyboard helper is not built at ${helper}`)
    diagnosticLog(`starting helper ${helper}; trigger=${this.triggerKey}`)
    const child = spawn(helper, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
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
    child.on('exit', (code) => {
      this.running = false
      this.child = null
      diagnosticLog(`helper exit code=${code ?? 'signal'}`)
      if (code !== 0 && code !== null) console.error(`[echo] key helper exited with code ${code}`)
    })
    this.running = true
  }

  stop(): void {
    if (!this.running) return
    this.child?.kill()
    this.child = null
    this.running = false
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

function diagnosticLog(message: string): void {
  try {
    const file = join(app.getPath('userData'), 'hotkey.log')
    if (existsSync(file) && statSync(file).size > 64 * 1024) truncateSync(file, 0)
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* Diagnostics must never affect dictation. */
  }
}
