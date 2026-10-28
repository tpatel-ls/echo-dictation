import { describe, expect, it, vi } from 'vitest'
import { OverlayHealth } from '../src/main/overlay-health'

describe('overlay health', () => {
  it('recovers a missing renderer heartbeat with bounded backoff', () => {
    const recover = vi.fn()
    const health = new OverlayHealth(recover, 0)
    health.check(29_999)
    expect(recover).not.toHaveBeenCalled()
    health.check(30_000)
    expect(recover).toHaveBeenCalledTimes(1)
    health.check(59_999)
    expect(recover).toHaveBeenCalledTimes(1)
    health.check(60_000)
    health.check(90_000)
    expect(recover).toHaveBeenCalledTimes(2)
    health.check(120_000)
    expect(recover).toHaveBeenCalledTimes(3)
  })

  it('stays healthy while React is mounted and recovers after it unmounts', () => {
    const recover = vi.fn()
    const health = new OverlayHealth(recover, 0)
    for (let t = 5000; t <= 120_000; t += 5000) {
      health.beat(t)
      health.check(t)
    }
    expect(recover).not.toHaveBeenCalled()
    health.check(150_000)
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('gives the renderer a grace period after resume and resets backoff on recovery', () => {
    const recover = vi.fn()
    const health = new OverlayHealth(recover, 0)
    health.check(30_000)
    health.beat(35_000)
    health.check(65_000)
    health.beat(3_600_000)
    health.check(3_600_001)
    expect(recover).toHaveBeenCalledTimes(2)
    health.check(3_630_000)
    expect(recover).toHaveBeenCalledTimes(3)
  })
})
