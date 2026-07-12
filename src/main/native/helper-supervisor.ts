export interface SupervisedProcess {
  kill(): unknown
  once(event: 'error', listener: (error: Error) => void): this
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this
}

export interface SupervisorScheduler {
  schedule(fn: () => void, ms: number): unknown
  cancel(handle: unknown): void
}

export interface HelperCrash {
  error?: Error
  code?: number | null
  signal?: NodeJS.Signals | null
  restartAttempt: number
}

export interface NativeHelperSupervisorOptions {
  spawn: () => SupervisedProcess
  scheduler?: SupervisorScheduler
  maxRestarts?: number
  baseDelayMs?: number
  onProcess?: (process: SupervisedProcess) => void
  onCrash?: (crash: HelperCrash) => void
  onExhausted?: (crash: HelperCrash) => void
}

const defaultScheduler: SupervisorScheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export class NativeHelperSupervisor {
  private process: SupervisedProcess | null = null
  private restartTimer: unknown = null
  private desired = false
  private restartAttempts = 0

  constructor(private readonly options: NativeHelperSupervisorOptions) {}

  get isRunning(): boolean {
    return this.process !== null
  }

  start(): void {
    this.desired = true
    if (this.process || this.restartTimer) return
    this.launch()
  }

  stop(): void {
    this.desired = false
    if (this.restartTimer) {
      this.scheduler.cancel(this.restartTimer)
      this.restartTimer = null
    }
    const process = this.process
    this.process = null
    try {
      process?.kill()
    } catch {
      // A process that already exited is effectively stopped.
    }
  }

  markHealthy(): void {
    this.restartAttempts = 0
  }

  private get scheduler(): SupervisorScheduler {
    return this.options.scheduler ?? defaultScheduler
  }

  private launch(): void {
    if (!this.desired) return
    let child: SupervisedProcess
    try {
      child = this.options.spawn()
      this.process = child
      this.options.onProcess?.(child)
    } catch (error) {
      this.handleCrash({ error: error as Error, restartAttempt: this.restartAttempts })
      return
    }

    let handled = false
    const finish = (crash: Omit<HelperCrash, 'restartAttempt'>): void => {
      if (handled || this.process !== child) return
      handled = true
      this.process = null
      this.handleCrash({ ...crash, restartAttempt: this.restartAttempts })
    }
    child.once('error', (error) => finish({ error }))
    child.once('exit', (code, signal) => finish({ code, signal }))
  }

  private handleCrash(crash: HelperCrash): void {
    if (!this.desired) return
    this.options.onCrash?.(crash)
    const maxRestarts = Math.max(0, this.options.maxRestarts ?? 4)
    if (this.restartAttempts >= maxRestarts) {
      this.desired = false
      this.options.onExhausted?.(crash)
      return
    }

    const attempt = this.restartAttempts++
    const baseDelayMs = Math.max(10, this.options.baseDelayMs ?? 250)
    const delayMs = Math.min(10_000, baseDelayMs * 2 ** attempt)
    this.restartTimer = this.scheduler.schedule(() => {
      this.restartTimer = null
      this.launch()
    }, delayMs)
  }
}
