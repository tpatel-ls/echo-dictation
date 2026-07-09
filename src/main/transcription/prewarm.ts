// Pre-warms the TCP+TLS connection to the Whisper server while the user is still speaking, so the
// transcription POST at key-release reuses a live socket instead of paying connection setup
// (measured: ~230 ms warm vs ~360-490 ms cold against the tailnet node). Node's fetch keep-alive
// expires after a few seconds, so one ping at hotkey-down isn't enough — a light ping repeats every
// few seconds until recording stops, guaranteeing a warm socket at release no matter how long the
// dictation runs.

export interface PrewarmDeps {
  fetch: typeof fetch
}

/** The cheap endpoint to ping: the server origin's /health (any response, even 404, warms TLS). */
export function prewarmUrl(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin + '/health'
  } catch {
    return null
  }
}

export class WhisperPrewarm {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private deps: PrewarmDeps = { fetch }) {}

  /** Begin pinging `baseUrl`'s origin every `intervalMs` until stop(). Fire-and-forget, never throws. */
  start(baseUrl: string, intervalMs = 3000): void {
    this.stop()
    const url = prewarmUrl(baseUrl)
    if (!url) return
    const ping = (): void => {
      this.deps.fetch(url, { method: 'GET' }).then(
        () => {},
        () => {}
      )
    }
    ping()
    this.timer = setInterval(ping, intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
