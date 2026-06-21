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

  constructor(
    private readonly run: () => Promise<void>,
    private readonly onError: (e: unknown) => void = (e) => console.error('[sync] pass failed:', e)
  ) {}

  /** Request a sync pass. Runs now if idle; otherwise coalesces into one follow-up pass. */
  trigger(): void {
    if (this.running) {
      this.pending = true
      return
    }
    void this.cycle()
  }

  /** Begin running passes on a fixed interval (replacing any existing one). */
  startInterval(ms: number): void {
    this.stop()
    this.interval = setInterval(() => this.trigger(), ms)
    this.interval.unref?.()
  }

  /** Stop the interval. In-flight and pending passes still settle. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private async cycle(): Promise<void> {
    this.running = true
    try {
      do {
        this.pending = false
        await this.run()
      } while (this.pending) // a trigger landed mid-pass → run exactly once more
    } catch (e) {
      // Swallow: a failed pass must not bubble (no unhandled rejection) or wedge the
      // runner. We deliberately do NOT honour `pending` on error — that would spin a
      // tight retry loop while the network is down; the interval retries instead.
      this.onError(e)
    } finally {
      this.running = false
    }
  }
}
