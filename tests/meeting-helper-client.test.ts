import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeetingHelperClient, type MeetingHelperProcess } from '../src/main/meetings/helper-client'
import type { MicSession, RecordLevels, RecordWarning } from '@shared/meeting-types'

class FakeHelper extends EventEmitter implements MeetingHelperProcess {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  writes: string[] = []
  stdinEnded = false
  killed = false
  stdin = {
    write: (chunk: string): boolean => {
      this.writes.push(chunk)
      return true
    },
    end: (): void => {
      this.stdinEnded = true
    }
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  send(raw: string): void {
    this.stdout.emit('data', Buffer.from(raw))
  }

  line(value: object): void {
    this.send(`${JSON.stringify(value)}\n`)
  }

  requests(): Array<Record<string, unknown>> {
    return this.writes.flatMap((chunk) => chunk.split('\n').filter(Boolean)).map((line) => JSON.parse(line))
  }

  exit(code: number | null = 1): void {
    this.emit('exit', code, null)
  }
}

const session: MicSession = {
  pid: 54276,
  appPid: 29672,
  exe: 'chrome.exe',
  path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  packageFamily: null,
  endpointId: '{0.0.1.00000000}.{abc}',
  endpointName: 'Microphone'
}

function setup(options: { platform?: NodeJS.Platform; exists?: boolean; requestTimeoutMs?: number } = {}) {
  const helpers: FakeHelper[] = []
  let nextId = 0
  const spawnHelper = vi.fn((_path: string, _args: string[]) => {
    const helper = new FakeHelper()
    helpers.push(helper)
    return helper
  })
  const client = new MeetingHelperClient({
    platform: options.platform ?? 'win32',
    resourcesPath: 'C:\\Echo\\resources',
    echoPid: 1234,
    requestTimeoutMs: options.requestTimeoutMs,
    requestId: () => `q${++nextId}`,
    spawnHelper,
    exists: () => options.exists ?? true,
    log: () => {}
  })
  const current = (): FakeHelper => helpers.at(-1)!
  const ready = (): void => current().line({ type: 'ready', version: 1, processLoopback: true })
  return { client, helpers, spawnHelper, current, ready }
}

describe('MeetingHelperClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('start', () => {
    it('spawns the helper from resources with the server flags and Echo pid', () => {
      const { client, spawnHelper } = setup()
      client.start()
      expect(spawnHelper).toHaveBeenCalledOnce()
      expect(spawnHelper.mock.calls[0]).toEqual([
        'C:\\Echo\\resources\\native\\EchoMeetingHelper.exe',
        ['--server', '--echo-pid', '1234']
      ])
    })

    it('does nothing off Windows', () => {
      const { client, spawnHelper } = setup({ platform: 'darwin' })
      client.start()
      expect(spawnHelper).not.toHaveBeenCalled()
      expect(client.available).toBe(false)
    })

    it('does nothing when the helper binary is missing', () => {
      const { client, spawnHelper } = setup({ exists: false })
      client.start()
      expect(spawnHelper).not.toHaveBeenCalled()
      expect(client.available).toBe(false)
    })

    it('becomes available only once the helper reports ready', () => {
      const { client, ready } = setup()
      client.start()
      expect(client.available).toBe(false)
      ready()
      expect(client.available).toBe(true)
    })
  })

  describe('stdout', () => {
    it('reassembles lines split across chunks and splits several lines in one chunk', () => {
      const { client, current, ready } = setup()
      const snapshots: MicSession[][] = []
      client.onMicSessions((sessions) => snapshots.push(sessions))
      client.start()
      ready()
      const text = `${JSON.stringify({ type: 'mic-sessions', sessions: [session] })}\r\n`
      current().send(text.slice(0, 17))
      current().send(text.slice(17, 60))
      expect(snapshots).toEqual([])
      current().send(`${text.slice(60)}${JSON.stringify({ type: 'mic-sessions', sessions: [] })}\n{"type":"mic-ses`)
      expect(snapshots).toEqual([[session], []])
      current().send('sions","sessions":[]}\n')
      expect(snapshots).toEqual([[session], [], []])
    })

    it('ignores malformed and unknown lines without losing the stream', () => {
      const { client, current, ready } = setup()
      const snapshots: MicSession[][] = []
      client.onMicSessions((sessions) => snapshots.push(sessions))
      client.start()
      ready()
      current().send('not json\n{"type":"mic-sessions","sessions":[{"pid":"x"}]}\n{"type":"surprise"}\n')
      current().line({ type: 'mic-sessions', sessions: [session] })
      expect(snapshots).toEqual([[session]])
    })

    it('delivers levels and warnings to their listeners until unsubscribed', () => {
      const { client, current, ready } = setup()
      const levels: RecordLevels[] = []
      const warnings: RecordWarning[] = []
      const offLevels = client.onLevels((l) => levels.push(l))
      client.onWarning((w) => warnings.push(w))
      client.start()
      ready()
      current().line({ type: 'record-levels', id: 'r1', mic: 0.1, others: 0.2, samples: 8000 })
      current().line({ type: 'record-warning', id: 'r1', code: 'mic-lost', message: 'gone' })
      offLevels()
      current().line({ type: 'record-levels', id: 'r1', mic: 0.3, others: 0.4, samples: 16000 })
      expect(levels).toEqual([{ id: 'r1', mic: 0.1, others: 0.2, samples: 8000 }])
      expect(warnings).toEqual([{ id: 'r1', code: 'mic-lost', message: 'gone' }])
    })
  })

  describe('requests', () => {
    it('matches probe replies to requests by id, in any order', async () => {
      const { client, current, ready } = setup()
      client.start()
      ready()
      const first = client.probe(['chrome.exe'])
      const second = client.probe(['ms-teams.exe'])
      expect(current().requests()).toEqual([
        { type: 'probe', id: 'q1', exes: ['chrome.exe'] },
        { type: 'probe', id: 'q2', exes: ['ms-teams.exe'] }
      ])
      const teams = { windows: [], tabs: [], render: [{ pid: 9, appPid: 8, exe: 'ms-teams.exe', endpointId: 'e', active: true, peak: 0.2 }] }
      current().line({ type: 'probe-result', id: 'q2', ...teams })
      current().line({ type: 'probe-result', id: 'unrelated', windows: [], tabs: [], render: [] })
      current().line({ type: 'probe-result', id: 'q1', windows: [], tabs: [{ appPid: 1, exe: 'chrome.exe', name: 'Meet - x' }], render: [] })
      await expect(second).resolves.toEqual(teams)
      await expect(first).resolves.toEqual({ windows: [], tabs: [{ appPid: 1, exe: 'chrome.exe', name: 'Meet - x' }], render: [] })
    })

    it('starts, retargets and stops a recording under the caller-supplied id', async () => {
      const { client, current, ready } = setup()
      client.start()
      ready()
      const started = client.startRecording({ id: 'r1', dir: 'C:\\m\\u1', otherPids: [5], micEndpointId: null })
      current().line({ type: 'record-started', id: 'r1', startedAt: 1000, othersMode: 'system', micName: 'Mic' })
      await expect(started).resolves.toEqual({ id: 'r1', startedAt: 1000, othersMode: 'system', micName: 'Mic' })

      client.retarget('r1', [5, 6])
      const stopped = client.stopRecording('r1')
      // A record-started for the same id must not satisfy the stop.
      current().line({ type: 'record-started', id: 'r1', startedAt: 1, othersMode: 'process', micName: '' })
      current().line({ type: 'record-stopped', id: 'r1', samples: 320000 })
      await expect(stopped).resolves.toEqual({ id: 'r1', samples: 320000 })
      expect(current().requests()).toEqual([
        { type: 'record-start', id: 'r1', dir: 'C:\\m\\u1', otherPids: [5], micEndpointId: null },
        { type: 'record-retarget', id: 'r1', otherPids: [5, 6] },
        { type: 'record-stop', id: 'r1' }
      ])
    })

    it('pauses and resumes the mic channel, resolving with the sample it applies from', async () => {
      const { client, current, ready } = setup()
      client.start()
      ready()
      const paused = client.setMicPaused('r1', true)
      const resumed = client.setMicPaused('r1', false)
      // A different reply for the same id must not satisfy it.
      current().line({ type: 'record-stopped', id: 'r1', samples: 5 })
      current().line({ type: 'record-mic-paused', id: 'r1', paused: true, samples: 48000 })
      current().line({ type: 'record-mic-paused', id: 'r1', paused: false, samples: 96000 })
      await expect(paused).resolves.toEqual({ id: 'r1', paused: true, samples: 48000 })
      await expect(resumed).resolves.toEqual({ id: 'r1', paused: false, samples: 96000 })
      expect(current().requests()).toEqual([
        { type: 'record-mic-pause', id: 'r1', paused: true },
        { type: 'record-mic-pause', id: 'r1', paused: false }
      ])
    })

    it('rejects a mic pause while the helper is not running', async () => {
      const { client } = setup()
      await expect(client.setMicPaused('r1', true)).rejects.toThrow('not running')
    })

    it('rejects a request the helper answers with an error for its id', async () => {
      const { client, current, ready } = setup()
      client.start()
      ready()
      const started = client.startRecording({ id: 'r1', dir: 'C:\\m', otherPids: [], micEndpointId: null })
      const probe = client.probe(['zoom.exe'])
      current().line({ type: 'error', id: 'r1', code: 'busy', message: 'A recording is already in progress' })
      await expect(started).rejects.toThrow('A recording is already in progress')
      await expect(started).rejects.toMatchObject({ code: 'busy' })
      current().line({ type: 'probe-result', id: 'q1', windows: [], tabs: [], render: [] })
      await expect(probe).resolves.toEqual({ windows: [], tabs: [], render: [] })
    })

    it('times out a request the helper never answers and ignores a late reply', async () => {
      const { client, current, ready } = setup({ requestTimeoutMs: 800 })
      client.start()
      ready()
      const probe = client.probe(['chrome.exe'])
      const outcome = probe.catch((error: Error) => error)
      vi.advanceTimersByTime(799)
      current().line({ type: 'probe-result', id: 'other', windows: [], tabs: [], render: [] })
      vi.advanceTimersByTime(1)
      expect(((await outcome) as Error).message).toMatch(/did not answer/)
      current().line({ type: 'probe-result', id: 'q1', windows: [], tabs: [], render: [] })
      expect(client.available).toBe(true)
    })

    it('uses a 5 s timeout by default', async () => {
      const { client, ready } = setup()
      client.start()
      ready()
      const outcome = client.stopRecording('r1').catch((error: Error) => error)
      vi.advanceTimersByTime(4999)
      await Promise.resolve()
      let settled = false
      void outcome.then(() => (settled = true))
      await Promise.resolve()
      expect(settled).toBe(false)
      vi.advanceTimersByTime(1)
      expect(((await outcome) as Error).message).toMatch(/did not answer/)
    })

    it('rejects requests while the helper is not ready', async () => {
      const { client, current } = setup()
      await expect(client.probe(['chrome.exe'])).rejects.toThrow(/not running/)
      client.start()
      await expect(client.probe(['chrome.exe'])).rejects.toThrow(/not running/)
      expect(current().writes).toEqual([])
    })
  })

  describe('helper exit', () => {
    it('rejects pending requests, drops availability and reports no mic sessions', async () => {
      const { client, current, ready } = setup()
      const snapshots: MicSession[][] = []
      client.onMicSessions((sessions) => snapshots.push(sessions))
      client.start()
      ready()
      current().line({ type: 'mic-sessions', sessions: [session] })
      const probe = client.probe(['chrome.exe']).catch((error: Error) => error)
      const stop = client.stopRecording('r1').catch((error: Error) => error)
      current().exit(3)
      expect(((await probe) as Error).message).toMatch(/exited/)
      expect(((await stop) as Error).message).toMatch(/exited/)
      expect(client.available).toBe(false)
      expect(snapshots).toEqual([[session], []])
    })

    it('restarts a crashed helper with backoff and becomes available again on ready', () => {
      const { client, helpers, spawnHelper, ready } = setup()
      client.start()
      ready()
      helpers[0]!.exit(1)
      expect(spawnHelper).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(10_000)
      expect(spawnHelper).toHaveBeenCalledTimes(2)
      expect(client.available).toBe(false)
      ready()
      expect(client.available).toBe(true)
      // Output from the dead process is ignored.
      helpers[0]!.line({ type: 'ready', version: 1, processLoopback: true })
      helpers[1]!.exit(1)
      expect(client.available).toBe(false)
    })
  })

  describe('stop', () => {
    it('asks the helper to shut down and does not restart it', () => {
      const { client, current, spawnHelper, ready } = setup()
      client.start()
      ready()
      client.stop()
      expect(current().requests()).toEqual([{ type: 'shutdown' }])
      expect(current().stdinEnded).toBe(true)
      expect(client.available).toBe(false)
      current().exit(0)
      vi.advanceTimersByTime(60_000)
      expect(current().killed).toBe(false)
      expect(spawnHelper).toHaveBeenCalledOnce()
    })

    it('kills a helper that has not exited 3 s after shutdown', () => {
      const { client, current, ready } = setup()
      client.start()
      ready()
      client.stop()
      vi.advanceTimersByTime(2999)
      expect(current().killed).toBe(false)
      vi.advanceTimersByTime(1)
      expect(current().killed).toBe(true)
    })

    it('rejects in-flight requests and reports no mic sessions', async () => {
      const { client, current, ready } = setup()
      const snapshots: MicSession[][] = []
      client.onMicSessions((sessions) => snapshots.push(sessions))
      client.start()
      ready()
      current().line({ type: 'mic-sessions', sessions: [session] })
      const probe = client.probe(['chrome.exe']).catch((error: Error) => error)
      client.stop()
      expect(((await probe) as Error).message).toMatch(/stopped|exited/)
      expect(snapshots).toEqual([[session], []])
    })

    it('can start again after stop', () => {
      const { client, spawnHelper, ready } = setup()
      client.start()
      ready()
      client.stop()
      client.start()
      expect(spawnHelper).toHaveBeenCalledTimes(2)
      ready()
      expect(client.available).toBe(true)
    })
  })
})
