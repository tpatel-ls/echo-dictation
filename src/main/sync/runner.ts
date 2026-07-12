// Schedules sync passes without ever overlapping them. `trigger()` is fired from three
// places — app start, the stores' debounced change hook, and a periodic interval — and
// any of those can arrive while a pass is already in flight. The runner collapses
// concurrent requests into a single follow-up pass and swallows transient failures, so a
// flaky network can never crash the app or stack up parallel syncs. Correctness of *what*
// syncs lives in the table watermarks/cursors, not here — a dropped trigger only delays a
// sync until the next change or interval tick, it never loses data.

export class SyncRunner {
  private running = false
  private pending = false
  private interval: ReturnType<typeof setInterval> | null = null
  private controller: AbortController | null = null
  private stopped = false

  constructor(
    private readonly run: (signal: AbortSignal) => Promise<void>,
    private readonly onError: (e: unknown) => void = (e) => console.error('[sync] pass failed:', e)
  ) {}

  /** Request a sync pass. Runs now if idle; otherwise coalesces into one follow-up pass. */
  trigger(): void {
    if (this.stopped) return
    if (this.running) {
      this.pending = true
      return
    }
    void this.cycle()
  }

  /** Begin running passes on a fixed interval (replacing any existing one). */
  startInterval(ms: number): void {
    if (this.interval) clearInterval(this.interval)
    this.stopped = false
    this.interval = setInterval(() => this.trigger(), ms)
    this.interval.unref?.()
  }

  /** Stop scheduling and cancel the in-flight network pass. */
  stop(): void {
    this.stopped = true
    this.pending = false
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    this.controller?.abort()
  }

  private async cycle(): Promise<void> {
    this.running = true
    const controller = new AbortController()
    this.controller = controller
    try {
      do {
        this.pending = false
        await this.run(controller.signal)
      } while (this.pending && !this.stopped) // a trigger landed mid-pass → run exactly once more
    } catch (e) {
      // Swallow: a failed pass must not bubble (no unhandled rejection) or wedge the
      // runner. We deliberately do NOT honour `pending` on error — that would spin a
      // tight retry loop while the network is down; the interval retries instead.
      if (!this.stopped || !controller.signal.aborted) this.onError(e)
    } finally {
      if (this.controller === controller) this.controller = null
      this.running = false
    }
  }
}
