import { describe, it, expect, vi } from 'vitest'
import { SyncRunner } from '../src/main/sync/runner'

/** A run function we settle by hand, so we can hold a run "in flight" and end it either way. */
function deferredRun(): {
  fn: () => Promise<void>
  calls: () => number
  resolveNext: () => void
  rejectNext: (e: unknown) => void
} {
  let calls = 0
  let resolve: (() => void) | null = null
  let reject: ((e: unknown) => void) | null = null
  return {
    fn: () =>
      new Promise<void>((res, rej) => {
        calls++
        resolve = res
        reject = rej
      }),
    calls: () => calls,
    resolveNext: () => {
      const r = resolve
      resolve = null
      r?.()
    },
    rejectNext: (e: unknown) => {
      const r = reject
      reject = null
      r?.(e)
    }
  }
}

describe('SyncRunner', () => {
  it('runs once when triggered while idle', async () => {
    const d = deferredRun()
    const runner = new SyncRunner(d.fn)
    runner.trigger()
    expect(d.calls()).toBe(1)
    d.resolveNext()
    await Promise.resolve()
    expect(d.calls()).toBe(1) // no spurious extra run
  })

  it('never runs two passes concurrently — triggers during a run coalesce to one follow-up', async () => {
    const d = deferredRun()
    const runner = new SyncRunner(d.fn)

    runner.trigger() // starts run #1
    expect(d.calls()).toBe(1)

    runner.trigger() // while #1 in flight
    runner.trigger() // …more triggers collapse together
    expect(d.calls()).toBe(1) // still only one running

    d.resolveNext() // finish run #1
    await Promise.resolve()
    await Promise.resolve()
    expect(d.calls()).toBe(2) // exactly one coalesced follow-up

    d.resolveNext() // finish run #2
    await Promise.resolve()
    await Promise.resolve()
    expect(d.calls()).toBe(2) // and it settles — no runaway loop
  })

  it('routes a run rejection to onError and stays usable for the next trigger', async () => {
    let calls = 0
    const errors: unknown[] = []
    const runner = new SyncRunner(
      () => {
        calls++
        return calls === 1 ? Promise.reject(new Error('network down')) : Promise.resolve()
      },
      (e) => errors.push(e)
    )

    runner.trigger() // run #1 rejects
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(errors).toHaveLength(1) // swallowed via onError — no unhandled rejection
    expect((errors[0] as Error).message).toBe('network down')

    runner.trigger() // runner not wedged by the prior failure
    await Promise.resolve()
    expect(calls).toBe(2)
  })

  it('drops a trigger that arrives during a failing run (no retry storm), then recovers later', async () => {
    const d = deferredRun()
    const errors: unknown[] = []
    const runner = new SyncRunner(d.fn, (e) => errors.push(e))

    runner.trigger() // run #1 starts and stays in flight
    expect(d.calls()).toBe(1)
    runner.trigger() // arrives mid-run → sets pending
    expect(d.calls()).toBe(1)

    d.rejectNext(new Error('down')) // run #1 fails
    await Promise.resolve()
    await Promise.resolve()
    expect(d.calls()).toBe(1) // pending deliberately dropped — the interval retries, no tight loop
    expect(errors).toHaveLength(1)

    runner.trigger() // a fresh trigger still runs (runner not wedged)
    expect(d.calls()).toBe(2)
    d.resolveNext() // let run #2 settle cleanly
    await Promise.resolve()
    expect(d.calls()).toBe(2)
  })

  it('triggers a run on each interval tick, and stop() halts them', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const runner = new SyncRunner(() => {
        calls++
        return Promise.resolve()
      })
      runner.startInterval(1000)
      expect(calls).toBe(0) // does not fire at t=0 — launch already triggers an initial pass
      await vi.advanceTimersByTimeAsync(1000)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(calls).toBe(2)
      runner.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls).toBe(2) // no ticks after stop
    } finally {
      vi.useRealTimers()
    }
  })
})
