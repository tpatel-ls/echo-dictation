import { describe, expect, it, vi } from 'vitest'
import type { AudioInputDevice } from '../src/renderer/overlay/audio-device'
import { MicStream, type InputStream, type InputTrack } from '../src/renderer/overlay/mic-stream'

class FakeTrack implements InputTrack {
  readyState: 'live' | 'ended' = 'live'
  private listeners: Array<() => void> = []

  constructor(readonly label: string) {}

  addEventListener(_type: 'ended', listener: () => void): void {
    this.listeners.push(listener)
  }

  stop(): void {
    this.readyState = 'ended'
  }

  /** What Chromium does when the device behind the track disappears. */
  lose(): void {
    this.readyState = 'ended'
    for (const listener of this.listeners) listener()
  }
}

class FakeStream implements InputStream {
  readonly track: FakeTrack

  constructor(readonly deviceId: string | undefined) {
    this.track = new FakeTrack(`Microphone (${deviceId ?? 'default'})`)
  }

  getAudioTracks(): FakeTrack[] {
    return [this.track]
  }
}

const webcam = { deviceId: 'webcam', label: 'Microphone (Lenovo FHD Webcam Audio)' }
const fifine = { deviceId: 'fifine', label: 'Microphone (3- fifine Microphone)' }

function setup(initialInputs: AudioInputDevice[] = [fifine, webcam]) {
  let inputs = initialInputs
  const opened: FakeStream[] = []
  const open = vi.fn(async (deviceId: string | undefined) => {
    const stream = new FakeStream(deviceId)
    opened.push(stream)
    return stream
  })
  const events: string[] = []
  const mic = new MicStream<FakeStream>({ listInputs: async () => inputs, open, log: (event) => events.push(event) })
  return {
    mic,
    open,
    opened,
    events,
    setInputs(next: AudioInputDevice[]) {
      inputs = next
    }
  }
}

/** Let fire-and-forget reopens settle; every fake resolves immediately. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('MicStream', () => {
  it('reopens a warm stream as soon as its device goes away', async () => {
    const { mic, open, opened } = setup()
    await mic.setWarm(true)
    opened[0]!.track.lose()
    await settle()

    expect(open).toHaveBeenCalledTimes(2)
    await expect(mic.acquire()).resolves.toBe(opened[1])
  })

  it('never hands a dead stream to a new take', async () => {
    const { mic, opened, events } = setup()
    await mic.setWarm(true)
    opened[0]!.track.readyState = 'ended'

    const stream = await mic.acquire()
    expect(stream).toBe(opened[1])
    expect(stream.track.readyState).toBe('live')
    expect(events).toContain('reopening: held stream was dead')
  })

  it('follows the mic when it reconnects or the default input changes', async () => {
    const { mic, opened, setInputs } = setup([webcam])
    await mic.setWarm(true)
    setInputs([webcam, fifine])
    await mic.onDeviceChange()
    await settle()

    expect(opened[0]!.track.readyState).toBe('ended')
    await expect(mic.acquire()).resolves.toBe(opened[1])
  })

  it('keeps the warm stream across device changes that leave the inputs alone', async () => {
    const { mic, open, opened } = setup()
    await mic.setWarm(true)
    await mic.onDeviceChange()
    await settle()

    expect(open).toHaveBeenCalledTimes(1)
    await expect(mic.acquire()).resolves.toBe(opened[0])
  })

  it('finishes the current take on its stream before switching', async () => {
    const { mic, open, opened, setInputs } = setup([webcam])
    await mic.setWarm(true)
    await mic.acquire()
    setInputs([webcam, fifine])
    await mic.onDeviceChange()
    await settle()
    expect(open).toHaveBeenCalledTimes(1)
    expect(opened[0]!.track.readyState).toBe('live')

    mic.release(true)
    await settle()
    expect(open).toHaveBeenCalledTimes(2)
    await expect(mic.acquire()).resolves.toBe(opened[1])
  })

  it('ignores device noise during a take that left the inputs alone', async () => {
    const { mic, open } = setup()
    await mic.setWarm(true)
    await mic.acquire()
    await mic.onDeviceChange()
    mic.release(true)
    await settle()

    expect(open).toHaveBeenCalledTimes(1)
  })

  it('reopens after a take that carried only digital silence', async () => {
    const { mic, opened } = setup()
    await mic.setWarm(true)
    await mic.acquire()
    mic.release(false)
    await settle()

    expect(opened[0]!.track.readyState).toBe('ended')
    await expect(mic.acquire()).resolves.toBe(opened[1])
  })

  it('keeps a warm stream that heard sound', async () => {
    const { mic, open, opened } = setup()
    await mic.setWarm(true)
    await mic.acquire()
    mic.release(true)
    await settle()

    expect(open).toHaveBeenCalledTimes(1)
    expect(opened[0]!.track.readyState).toBe('live')
  })

  it('closes the mic after each take when not warm', async () => {
    const { mic, open, opened } = setup()
    await mic.acquire()
    mic.release(true)
    await mic.onDeviceChange()
    await settle()

    expect(open).toHaveBeenCalledTimes(1)
    expect(opened[0]!.track.readyState).toBe('ended')
  })

  it('shares one open between a prewarm and a key press', async () => {
    const { mic, open } = setup()
    const [, stream] = await Promise.all([mic.setWarm(true), mic.acquire()])

    expect(open).toHaveBeenCalledTimes(1)
    expect(stream.track.readyState).toBe('live')
  })

  it('retries on the system default when the chosen mic is unplugged mid-open', async () => {
    const { mic, open } = setup()
    open.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NotFoundError' }))
    mic.setPreferredDevice('fifine')

    const stream = await mic.acquire()
    expect(open.mock.calls.map(([deviceId]) => deviceId)).toEqual(['fifine', undefined])
    expect(stream.deviceId).toBeUndefined()
  })

  it('logs why the mic was reopened and what it opened', async () => {
    const { mic, open, opened, events, setInputs } = setup([webcam])
    await mic.setWarm(true)
    opened[0]!.track.lose()
    await settle()
    setInputs([webcam, fifine])
    await mic.onDeviceChange()
    await settle()
    await mic.acquire()
    mic.release(false)
    await settle()
    open.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    opened[3]!.track.lose()
    await settle()

    expect(events).toEqual([
      'opened: Microphone (default)',
      'reopening: stream ended',
      'opened: Microphone (default)',
      'reopening: inputs changed',
      'opened: Microphone (default)',
      'reopening: take heard only silence',
      'opened: Microphone (default)',
      'reopening: stream ended',
      'open failed: NotAllowedError'
    ])
  })

  it('surfaces a blocked mic to the take that needed it', async () => {
    const { mic, open } = setup()
    open.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))

    await expect(mic.acquire()).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(mic.acquire()).resolves.toBeInstanceOf(FakeStream)
  })
})
