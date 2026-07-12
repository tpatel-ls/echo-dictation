import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  NativeHelperSupervisor,
  type SupervisedProcess,
  type SupervisorScheduler
} from '../src/main/native/helper-supervisor'

class FakeProcess extends EventEmitter {
  kill = vi.fn()
}

function harness(maxRestarts = 2): {
  children: FakeProcess[]
  scheduled: Array<{ fn: () => void; ms: number }>
  supervisor: NativeHelperSupervisor
  onExhausted: ReturnType<typeof vi.fn>
} {
  const children: FakeProcess[] = []
  const scheduled: Array<{ fn: () => void; ms: number }> = []
  const scheduler: SupervisorScheduler = {
    schedule: (fn, ms) => {
      const item = { fn, ms }
      scheduled.push(item)
      return item
    },
    cancel: vi.fn()
  }
  const onExhausted = vi.fn()
  const supervisor = new NativeHelperSupervisor({
    spawn: () => {
      const child = new FakeProcess()
      children.push(child)
      return child as unknown as SupervisedProcess
    },
    scheduler,
    maxRestarts,
    baseDelayMs: 100,
    healthyAfterMs: 1_000,
    onExhausted
  })
  return { children, scheduled, supervisor, onExhausted }
}

describe('NativeHelperSupervisor', () => {
  it('starts once and stops the managed process intentionally', () => {
    const { children, scheduled, supervisor } = harness()
    supervisor.start()
    supervisor.start()
    expect(children).toHaveLength(1)
    expect(supervisor.isRunning).toBe(true)

    supervisor.stop()
    expect(children[0].kill).toHaveBeenCalledOnce()
    expect(supervisor.isRunning).toBe(false)
    expect(scheduled).toHaveLength(0)
  })

  it('restarts crashes with bounded exponential delays', () => {
    const { children, scheduled, supervisor } = harness(2)
    supervisor.start()
    children[0].emit('exit', 2, null)
    expect(scheduled.map((item) => item.ms)).toEqual([100])

    scheduled.shift()?.fn()
    children[1].emit('error', new Error('crash'))
    children[1].emit('exit', 2, null)
    expect(scheduled.map((item) => item.ms)).toEqual([200])
  })

  it('stops restarting after the budget is exhausted', () => {
    const { children, scheduled, supervisor, onExhausted } = harness(1)
    supervisor.start()
    children[0].emit('exit', 1, null)
    scheduled.shift()?.fn()
    children[1].emit('exit', 1, null)

    expect(scheduled).toHaveLength(0)
    expect(onExhausted).toHaveBeenCalledOnce()
    expect(supervisor.isRunning).toBe(false)
  })

  it('cancels a pending restart when stopped and resets its budget when healthy', () => {
    const { children, scheduled, supervisor } = harness(1)
    supervisor.start()
    children[0].emit('exit', 1, null)
    supervisor.stop()
    scheduled[0].fn()
    expect(children).toHaveLength(1)

    supervisor.start()
    supervisor.markHealthy()
    scheduled.at(-1)?.fn()
    children[1].emit('exit', 1, null)
    expect(scheduled.at(-1)?.ms).toBe(100)
  })

  it('does not reset crash backoff until the process stays healthy long enough', () => {
    const { children, scheduled, supervisor } = harness(3)
    supervisor.start()
    children[0].emit('exit', 1, null)
    scheduled.shift()?.fn()
    supervisor.markHealthy()
    children[1].emit('exit', 1, null)
    expect(scheduled.at(-1)?.ms).toBe(200)
  })
})
