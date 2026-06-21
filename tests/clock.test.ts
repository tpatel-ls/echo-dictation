import { describe, it, expect } from 'vitest'
import { monotonicClock } from '../src/main/store/clock'

describe('monotonicClock', () => {
  it('tracks the wall clock when it moves forward', () => {
    let t = 1000
    const now = monotonicClock(() => t)
    expect(now()).toBe(1000)
    t = 1005
    expect(now()).toBe(1005)
  })

  it('never returns the same value twice, even when the time source is frozen', () => {
    const now = monotonicClock(() => 1000)
    expect(now()).toBe(1000)
    expect(now()).toBe(1001)
    expect(now()).toBe(1002)
  })

  it('never goes backward when the time source regresses', () => {
    let t = 5000
    const now = monotonicClock(() => t)
    expect(now()).toBe(5000)
    t = 4000 // wall clock jumped back (NTP, DST, etc.)
    expect(now()).toBe(5001)
  })
})
