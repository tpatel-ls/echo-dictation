import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  NativeSpeechRecognizer,
  parseSpeechLine,
  speechHelperPath,
  type SpeechHelperProcess
} from '../src/main/transcription/native-speech'

class FakeStdin {
  writes: string[] = []
  destroyed = false

  write(chunk: string): void {
    this.writes.push(chunk)
  }

  end(): void {
    this.destroyed = true
  }
}

class FakeProcess extends EventEmitter implements SpeechHelperProcess {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = new FakeStdin()
  killed = false

  kill(): void {
    this.killed = true
  }

  emitStdout(line: string): void {
    this.stdout.emit('data', Buffer.from(`${line}\n`))
  }
}

function expectChild(child: FakeProcess | null): FakeProcess {
  if (!child) throw new Error('expected helper process')
  return child
}

describe('native speech helper protocol', () => {
  it('parses result lines', () => {
    expect(parseSpeechLine('{"type":"result","id":"1","text":"Hello.","elapsedMs":42}')).toMatchObject({
      type: 'result',
      id: '1',
      text: 'Hello.',
      elapsedMs: 42
    })
  })

  it('rejects malformed or unknown lines', () => {
    expect(parseSpeechLine('not json')).toBeNull()
    expect(parseSpeechLine('{"type":"surprise","id":"1"}')).toBeNull()
  })

  it('resolves packaged and development helper paths without invoking Electron', () => {
    expect(speechHelperPath('darwin', '/resources')).toBe(
      '/resources/native/EchoSpeechHelper.app/Contents/MacOS/EchoSpeechHelper'
    )
    expect(speechHelperPath('win32', 'C:\\resources')).toBe(
      'C:\\resources\\native\\EchoSpeechHelper.exe'
    )
    expect(speechHelperPath('darwin', undefined, '/repo')).toBe(
      '/repo/out/native/EchoSpeechHelper.app/Contents/MacOS/EchoSpeechHelper'
    )
  })
})

describe('NativeSpeechRecognizer', () => {
  it('starts one lazy helper and resolves a transcribe result as a native candidate', async () => {
    let child: FakeProcess | null = null
    const spawnHelper = vi.fn(() => {
      child = new FakeProcess()
      return child
    })
    const recognizer = new NativeSpeechRecognizer({
      platform: 'darwin',
      resourcesPath: '/resources',
      spawnHelper,
      requestId: () => 'req-1',
      timeoutMs: 1500
    })

    const pending = recognizer.transcribe('/tmp/echo.wav', 'en-US')
    const helper = expectChild(child)

    expect(spawnHelper).toHaveBeenCalledOnce()
    expect(helper.stdin.writes).toEqual(['{"type":"transcribe","id":"req-1","path":"/tmp/echo.wav","locale":"en-US"}\n'])

    helper.emitStdout('{"type":"result","id":"req-1","text":"Hello world.","elapsedMs":42}')

    await expect(pending).resolves.toEqual({
      source: 'native',
      text: 'Hello world.',
      elapsedMs: 42
    })
  })

  it('treats authorization or availability errors as a soft null result', async () => {
    let child: FakeProcess | null = null
    const recognizer = new NativeSpeechRecognizer({
      platform: 'darwin',
      resourcesPath: '/resources',
      spawnHelper: () => {
        child = new FakeProcess()
        return child
      },
      requestId: () => 'req-2',
      timeoutMs: 1500
    })

    const pending = recognizer.transcribe('/tmp/echo.wav', 'en-US')
    expectChild(child).emitStdout(
      '{"type":"error","id":"req-2","code":"not-authorized","message":"Speech Recognition permission is not granted"}'
    )

    await expect(pending).resolves.toBeNull()
  })

  it('times out requests and shuts down the long-running helper', async () => {
    vi.useFakeTimers()
    let child: FakeProcess | null = null
    const recognizer = new NativeSpeechRecognizer({
      platform: 'darwin',
      resourcesPath: '/resources',
      spawnHelper: () => {
        child = new FakeProcess()
        return child
      },
      requestId: () => 'req-3',
      timeoutMs: 25
    })

    const pending = recognizer.transcribe('/tmp/echo.wav', 'en-US')
    await vi.advanceTimersByTimeAsync(25)

    await expect(pending).resolves.toBeNull()
    recognizer.shutdown()
    const helper = expectChild(child)
    expect(helper.stdin.destroyed).toBe(true)
    expect(helper.killed).toBe(true)
    vi.useRealTimers()
  })
})
