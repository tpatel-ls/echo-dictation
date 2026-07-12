import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/echo-tests' }
}))

import {
  HotkeyListener,
  type HotkeyListenerDeps
} from '../src/main/hotkey/listener'

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream()
  stderr = new FakeStream()
  kill = vi.fn()

  send(event: unknown): void {
    this.stdout.emit('data', `${JSON.stringify(event)}\n`)
  }
}

function setup(): {
  listener: HotkeyListener
  children: FakeChild[]
  onStart: ReturnType<typeof vi.fn>
  onStop: ReturnType<typeof vi.fn>
} {
  const children: FakeChild[] = []
  const deps: HotkeyListenerDeps = {
    exists: () => true,
    helperPath: () => '/helpers/EchoKeyHelper',
    spawn: () => {
      const child = new FakeChild()
      children.push(child)
      return child
    }
  }
  const onStart = vi.fn()
  const onStop = vi.fn()
  const listener = new HotkeyListener(
    { minHoldMs: 100, cancelOnOtherKey: true },
    'RightOption',
    { onStart, onStop, onCancel: vi.fn() },
    deps
  )
  return { listener, children, onStart, onStop }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('HotkeyListener recovery', () => {
  it('restarts a crashed key helper and continues delivering Option events', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { listener, children, onStart, onStop } = setup()
    listener.start()
    children[0].emit('exit', 2, null)

    await vi.advanceTimersByTimeAsync(250)
    expect(children).toHaveLength(2)
    children[1].send({ type: 'ready' })
    vi.setSystemTime(1_000)
    children[1].send({ type: 'key', key: 'rightOption', down: true })
    vi.setSystemTime(1_150)
    children[1].send({ type: 'key', key: 'rightOption', down: false })

    expect(onStart).toHaveBeenCalledOnce()
    expect(onStop).toHaveBeenCalledWith(150)
    expect(listener.isRunning).toBe(true)
  })

  it('does not restart after an intentional stop', async () => {
    vi.useFakeTimers()
    const { listener, children } = setup()
    listener.start()
    children[0].emit('exit', 2, null)
    listener.stop()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(children).toHaveLength(1)
    expect(listener.isRunning).toBe(false)
  })
})
