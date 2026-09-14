import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  PASTE_SERVER_ARGS,
  PasteHelperError,
  PasteHelperServer,
  type PasteHelperProcess
} from '../src/main/insert/paste-server'

class FakeHelper extends EventEmitter implements PasteHelperProcess {
  stdout = new EventEmitter()
  writes: string[] = []
  killed = false
  stdin = {
    write: (chunk: string): void => {
      this.writes.push(chunk)
    },
    end: (): void => {}
  }

  kill(): void {
    this.killed = true
  }

  reply(line: object): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(line)}\n`))
  }

  lastId(): string {
    return JSON.parse(this.writes.at(-1) ?? '{}').id
  }
}

function server(timeoutMs = 1500) {
  const helpers: FakeHelper[] = []
  const spawnHelper = vi.fn((_path: string, _args: string[]) => {
    const helper = new FakeHelper()
    helpers.push(helper)
    return helper
  })
  return { helpers, spawnHelper, paste: new PasteHelperServer({ helperPath: () => 'EchoPasteHelper.exe', spawnHelper, timeoutMs }) }
}

describe('PasteHelperServer', () => {
  it('reuses one warm helper for every paste', async () => {
    const { helpers, spawnHelper, paste } = server()
    paste.warm()

    const first = paste.send('paste')
    helpers[0]!.reply({ type: 'ok', id: helpers[0]!.lastId() })
    await first
    const second = paste.send('copy')
    helpers[0]!.reply({ type: 'ok', id: helpers[0]!.lastId() })
    await second

    expect(spawnHelper).toHaveBeenCalledOnce()
    expect(spawnHelper.mock.calls[0]![1]).toEqual(PASTE_SERVER_ARGS)
    expect(helpers[0]!.writes.map((line) => JSON.parse(line).action)).toEqual(['paste', 'copy'])
  })

  it('reports a rejected keystroke as a paste error', async () => {
    const { helpers, paste } = server()
    const pending = paste.send('paste')
    helpers[0]!.reply({ type: 'error', id: helpers[0]!.lastId(), message: 'SendInput failed' })

    await expect(pending).rejects.toBeInstanceOf(PasteHelperError)
  })

  it('fails in-flight pastes when the helper exits and starts a fresh one next time', async () => {
    const { helpers, spawnHelper, paste } = server()
    const pending = paste.send('paste')
    helpers[0]!.emit('exit', 0)

    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PasteHelperError)
    expect((error as Error).message).toMatch(/exited/)
    const next = paste.send('paste')
    helpers[1]!.reply({ type: 'ok', id: helpers[1]!.lastId() })
    await next
    expect(spawnHelper).toHaveBeenCalledTimes(2)
  })

  it('kills a helper that stops answering', async () => {
    vi.useFakeTimers()
    try {
      const { helpers, paste } = server(50)
      const pending = paste.send('paste')
      const assertion = expect(pending).rejects.toThrow(/did not answer/)
      await vi.advanceTimersByTimeAsync(60)
      await assertion
      expect(helpers[0]!.killed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
