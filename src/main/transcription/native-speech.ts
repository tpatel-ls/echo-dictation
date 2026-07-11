import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { EventEmitter } from 'node:events'
import type { TranscriptCandidate } from '@shared/transcript-quality'
import type { SecondaryRecognizer } from './accuracy'
import { helperPath } from '../native/helper-path'

export type SpeechHelperLine =
  | {
      type: 'ready'
      engine: string
      authorization: string
      speechAnalyzerAvailable?: boolean
      localeAvailable?: boolean
      installedLocales?: string[]
    }
  | {
      type: 'check'
      engine: string
      authorization: string
      speechAnalyzerAvailable: boolean
      localeAvailable: boolean
      installedLocales: string[]
    }
  | { type: 'result'; id: string; text: string; elapsedMs: number }
  | { type: 'error'; id?: string; code: string; message: string }

export interface SpeechHelperProcess {
  stdout: EventEmitter
  stderr?: EventEmitter | null
  stdin: {
    write(chunk: string): void
    end(): void
  }
  kill(signal?: NodeJS.Signals | number): void
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export interface NativeSpeechRecognizerOptions {
  platform?: NodeJS.Platform
  resourcesPath?: string
  cwd?: string
  timeoutMs?: number
  requestId?: () => string
  spawnHelper?: (path: string, args: string[]) => SpeechHelperProcess
}

interface PendingRequest {
  timer: ReturnType<typeof setTimeout>
  resolve: (candidate: TranscriptCandidate | null) => void
}

const DEFAULT_TIMEOUT_MS = 1500

export function parseSpeechLine(line: string): SpeechHelperLine | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (o.type === 'ready' && typeof o.engine === 'string' && typeof o.authorization === 'string') {
    return {
      type: 'ready',
      engine: o.engine,
      authorization: o.authorization,
      speechAnalyzerAvailable: typeof o.speechAnalyzerAvailable === 'boolean' ? o.speechAnalyzerAvailable : undefined,
      localeAvailable: typeof o.localeAvailable === 'boolean' ? o.localeAvailable : undefined,
      installedLocales: stringArray(o.installedLocales)
    }
  }
  if (
    o.type === 'check' &&
    typeof o.engine === 'string' &&
    typeof o.authorization === 'string' &&
    typeof o.speechAnalyzerAvailable === 'boolean' &&
    typeof o.localeAvailable === 'boolean'
  ) {
    return {
      type: 'check',
      engine: o.engine,
      authorization: o.authorization,
      speechAnalyzerAvailable: o.speechAnalyzerAvailable,
      localeAvailable: o.localeAvailable,
      installedLocales: stringArray(o.installedLocales) ?? []
    }
  }
  if (o.type === 'result' && typeof o.id === 'string' && typeof o.text === 'string') {
    return {
      type: 'result',
      id: o.id,
      text: o.text,
      elapsedMs: typeof o.elapsedMs === 'number' ? o.elapsedMs : 0
    }
  }
  if (o.type === 'error' && typeof o.code === 'string' && typeof o.message === 'string') {
    return {
      type: 'error',
      id: typeof o.id === 'string' ? o.id : undefined,
      code: o.code,
      message: o.message
    }
  }
  return null
}

export function speechHelperPath(
  platform: NodeJS.Platform = process.platform,
  resourcesPath?: string,
  cwd = process.cwd()
): string | null {
  if (platform !== 'darwin' && platform !== 'win32') return null
  return helperPath('EchoSpeechHelper', platform, resourcesPath, cwd)
}

export class NativeSpeechRecognizer implements SecondaryRecognizer {
  private child: SpeechHelperProcess | null = null
  private stdoutBuffer = ''
  private pending = new Map<string, PendingRequest>()

  constructor(private opts: NativeSpeechRecognizerOptions = {}) {}

  transcribe(wavPath: string, locale: 'en-US'): Promise<TranscriptCandidate | null> {
    const helper = speechHelperPath(this.opts.platform, this.opts.resourcesPath, this.opts.cwd)
    if (!helper || (!this.opts.spawnHelper && !existsSync(helper))) return Promise.resolve(null)

    const child = this.ensureChild(helper)
    if (!child) return Promise.resolve(null)

    const id = (this.opts.requestId ?? randomUUID)()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finish(id, null)
        this.stopChild()
      }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      this.pending.set(id, { timer, resolve })
      try {
        child.stdin.write(`${JSON.stringify({ type: 'transcribe', id, path: wavPath, locale })}\n`)
      } catch {
        this.finish(id, null)
      }
    })
  }

  shutdown(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, null)
    this.stopChild()
  }

  private stopChild(): void {
    if (!this.child) return
    try {
      this.child.stdin.end()
    } catch {
      /* ignore */
    }
    try {
      this.child.kill()
    } catch {
      /* ignore */
    }
    this.child = null
    this.stdoutBuffer = ''
  }

  private ensureChild(helper: string): SpeechHelperProcess | null {
    if (this.child) return this.child
    try {
      const spawnHelper = this.opts.spawnHelper ?? defaultSpawnHelper
      this.child = spawnHelper(helper, ['--server'])
      this.child.stdout.on('data', (chunk) => this.onStdout(String(chunk)))
      this.child.on('error', () => this.onExit())
      this.child.on('exit', () => this.onExit())
      this.child.on('close', () => this.onExit())
      return this.child
    } catch {
      return null
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line) this.handleLine(parseSpeechLine(line))
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private handleLine(line: SpeechHelperLine | null): void {
    if (!line) return
    if (line.type === 'result') {
      const text = line.text.trim()
      this.finish(line.id, text ? { source: 'native', text, elapsedMs: line.elapsedMs } : null)
      return
    }
    if (line.type === 'error' && line.id) this.finish(line.id, null)
  }

  private onExit(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, null)
    this.child = null
    this.stdoutBuffer = ''
  }

  private finish(id: string, candidate: TranscriptCandidate | null): void {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    pending.resolve(candidate)
  }
}

export function checkNativeSpeechStatus(opts: NativeSpeechRecognizerOptions = {}): Promise<SpeechHelperLine | null> {
  const helper = speechHelperPath(opts.platform, opts.resourcesPath, opts.cwd)
  if (!helper || (!opts.spawnHelper && !existsSync(helper))) return Promise.resolve(null)
  const spawnHelper = opts.spawnHelper ?? defaultSpawnHelper
  return new Promise((resolve) => {
    let settled = false
    let buffer = ''
    let child: SpeechHelperProcess
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (line: SpeechHelperLine | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        child.stdin.end()
      } catch {
        /* ignore */
      }
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve(line)
    }
    try {
      child = spawnHelper(helper, [])
    } catch {
      resolve(null)
      return
    }
    timer = setTimeout(() => finish(null), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      finish(parseSpeechLine(buffer.slice(0, newline).trim()))
    })
    child.on('error', () => finish(null))
    child.on('exit', () => finish(null))
    try {
      child.stdin.write(`${JSON.stringify({ type: 'check', locale: 'en-US' })}\n`)
    } catch {
      finish(null)
    }
  })
}

function defaultSpawnHelper(path: string, args: string[]): SpeechHelperProcess {
  return spawn(path, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }) as unknown as SpeechHelperProcess
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((item) => typeof item === 'string') ? value : undefined
}
