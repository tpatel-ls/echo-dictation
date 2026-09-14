// Keeps the Windows paste helper running between dictations. Starting a self-contained .NET exe costs
// about half a second per paste; a warm helper sends the Ctrl+V chord in milliseconds.

import { spawn } from 'node:child_process'
import type { EventEmitter } from 'node:events'

export interface PasteHelperProcess {
  stdout: EventEmitter
  stdin: {
    write(chunk: string): void
    end(): void
  }
  kill(): void
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number | null) => void): this
}

export interface PasteHelperServerOptions {
  helperPath: () => string
  spawnHelper?: (path: string, args: string[]) => PasteHelperProcess
  timeoutMs?: number
}

/** The helper ran but Windows rejected the synthetic keystrokes. Retrying via a new process won't help. */
export class PasteHelperError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PasteHelperError'
  }
}

/** `--check` is a harmless fallback: a helper built before server mode reports and exits, never pastes. */
export const PASTE_SERVER_ARGS = ['--server', '--check']
const DEFAULT_TIMEOUT_MS = 1500

interface Pending {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class PasteHelperServer {
  private child: PasteHelperProcess | null = null
  private buffer = ''
  private nextId = 0
  private pending = new Map<string, Pending>()

  constructor(private opts: PasteHelperServerOptions) {}

  /** Start the helper ahead of the first paste. Never throws. */
  warm(): void {
    try {
      this.ensureChild()
    } catch {
      /* the next send reports it */
    }
  }

  send(action: 'paste' | 'copy'): Promise<void> {
    let child: PasteHelperProcess
    try {
      child = this.ensureChild()
    } catch (error) {
      return Promise.reject(error)
    }
    const id = String(++this.nextId)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id, new Error('Paste helper did not answer'))
        this.stop()
      }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${JSON.stringify({ id, action })}\n`)
      } catch (error) {
        this.settle(id, error as Error)
        this.stop()
      }
    })
  }

  stop(): void {
    const child = this.child
    this.onExit()
    if (!child) return
    try {
      child.stdin.end()
      child.kill()
    } catch {
      /* already gone */
    }
  }

  private ensureChild(): PasteHelperProcess {
    if (this.child) return this.child
    const spawnHelper = this.opts.spawnHelper ?? defaultSpawnHelper
    const child = spawnHelper(this.opts.helperPath(), PASTE_SERVER_ARGS)
    this.child = child
    child.stdout.on('data', (chunk) => this.onStdout(String(chunk)))
    child.on('error', () => this.exitIfCurrent(child))
    child.on('exit', () => this.exitIfCurrent(child))
    return child
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.onLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let message: { type?: unknown; id?: unknown; message?: unknown }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (typeof message.id !== 'string') return
    if (message.type === 'ok') this.settle(message.id)
    else if (message.type === 'error') {
      this.settle(message.id, new PasteHelperError(typeof message.message === 'string' ? message.message : 'Paste failed'))
    }
  }

  private exitIfCurrent(child: PasteHelperProcess): void {
    if (this.child === child) this.onExit()
  }

  private onExit(): void {
    this.child = null
    this.buffer = ''
    for (const id of [...this.pending.keys()]) this.settle(id, new Error('Paste helper exited'))
  }

  private settle(id: string, error?: Error): void {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    if (error) pending.reject(error)
    else pending.resolve()
  }
}

function defaultSpawnHelper(path: string, args: string[]): PasteHelperProcess {
  return spawn(path, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }) as unknown as PasteHelperProcess
}
