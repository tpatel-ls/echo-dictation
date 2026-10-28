/** A heartbeat from the mounted React tree catches blank UI as well as hung renderers. */
export class OverlayHealth {
  private deadline: number
  private retryMs = 30_000

  constructor(private recover: () => void, now: number) {
    this.deadline = now + 30_000
  }

  beat(now: number): void {
    this.deadline = now + 30_000
    this.retryMs = 30_000
  }

  check(now: number): void {
    if (now < this.deadline) return
    this.deadline = now + this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, 300_000)
    this.recover()
  }
}
