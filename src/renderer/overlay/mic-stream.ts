// Keeps the microphone stream alive across dictations. A held ("warm") stream dies quietly when its
// device goes away — a USB mic resetting, a headset disconnecting — and every later take then records
// pure silence, which Whisper hears as "Thank you." So the stream is reopened when it ends, when the
// set of inputs changes (the mic came back, or the default moved), and after a take that heard only
// digital zeros. DOM-free: the browser calls come in as deps, so the lifecycle is unit-tested.

import { resolveAudioDevice, type AudioInputDevice } from './audio-device'

/** The slice of MediaStreamTrack this module relies on. */
export interface InputTrack {
  readonly label: string
  readonly readyState: string
  addEventListener(type: 'ended', listener: () => void): void
  stop(): void
}

/** The slice of MediaStream this module relies on. */
export interface InputStream {
  getAudioTracks(): InputTrack[]
}

export interface MicStreamDeps<S extends InputStream> {
  /** Audio inputs as the OS reports them right now. */
  listInputs(): Promise<AudioInputDevice[]>
  /** Open a stream on `deviceId`, or on the system default when it's undefined. */
  open(deviceId: string | undefined): Promise<S>
  /** Lifecycle events — what was opened and why it was reopened — for the diagnostic log. */
  log?(event: string): void
}

export class MicStream<S extends InputStream> {
  private stream: S | null = null
  private opening: Promise<S> | null = null
  /** The inputs that existed when `stream` was opened. */
  private streamInputs = ''
  private preferredDeviceId = ''
  private warm = false
  private recording = false
  /** Why to reopen once the current take ends; something changed mid-take and it isn't cut off. */
  private stale: string | null = null
  /** Devices changed mid-take; once it ends, check whether the inputs actually did. */
  private devicesChanged = false

  constructor(private deps: MicStreamDeps<S>) {}

  setPreferredDevice(deviceId: string): void {
    if (deviceId === this.preferredDeviceId) return
    this.preferredDeviceId = deviceId
    if (this.recording) this.stale = 'preferred mic changed'
    else this.reopen('preferred mic changed')
  }

  /** Warm mode keeps the mic open between dictations so a key press has no acquisition latency. */
  async setWarm(warm: boolean): Promise<void> {
    this.warm = warm
    if (warm) {
      try {
        await this.ensure()
      } catch {
        /* mic unavailable — acquire() will surface it when actually used */
      }
    } else if (!this.recording) {
      this.drop()
    }
  }

  /** A live stream for a new take. */
  async acquire(): Promise<S> {
    this.recording = true
    try {
      return await this.ensure()
    } catch (error) {
      this.recording = false
      throw error
    }
  }

  /** The take is over. `heardSound` false means every sample was zero: the stream is dead. */
  release(heardSound: boolean): void {
    if (!this.recording) return
    this.recording = false
    const reason = this.stale ?? (heardSound ? null : 'take heard only silence')
    const recheck = this.devicesChanged
    this.stale = null
    this.devicesChanged = false
    if (reason) this.reopen(reason)
    else if (!this.warm) this.drop()
    else if (recheck) void this.onDeviceChange().catch(() => {})
  }

  async onDeviceChange(): Promise<void> {
    if (this.recording) {
      this.devicesChanged = true
      return
    }
    await this.opening?.catch(() => null)
    const inputs = inputsKey(await this.deps.listInputs())
    if (this.recording) {
      this.devicesChanged = true
      return
    }
    if (!this.stream) {
      if (this.warm) this.reopen('no mic open')
    } else if (!isLive(this.stream)) {
      this.reopen('stream ended')
    } else if (inputs !== this.streamInputs) {
      this.reopen('inputs changed')
    }
  }

  private ensure(): Promise<S> {
    if (this.stream && isLive(this.stream)) return Promise.resolve(this.stream)
    if (this.stream) this.log('reopening: held stream was dead')
    this.drop()
    this.opening ??= this.open()
      .catch((error: unknown) => {
        this.log(`open failed: ${(error as Error)?.name ?? String(error)}`)
        throw error
      })
      .finally(() => {
        this.opening = null
      })
    return this.opening
  }

  private async open(): Promise<S> {
    const inputs = await this.deps.listInputs()
    const resolved = resolveAudioDevice(this.preferredDeviceId, inputs)
    let stream: S
    try {
      stream = await this.deps.open(resolved.deviceId)
    } catch (error) {
      const name = (error as Error)?.name
      if (!resolved.deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw error
      stream = await this.deps.open(undefined)
    }
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => this.onEnded(stream))
    this.stream = stream
    this.streamInputs = inputsKey(inputs)
    this.log(`opened: ${stream.getAudioTracks()[0]?.label || 'unlabeled input'}`)
    return stream
  }

  private onEnded(stream: S): void {
    if (stream !== this.stream) return
    if (this.recording) this.stale = 'stream ended'
    else this.reopen('stream ended')
  }

  /** Drop the held stream; warm mode opens the current device right away so the next press is instant. */
  private reopen(reason: string): void {
    this.log(`reopening: ${reason}`)
    this.drop()
    if (this.warm) void this.ensure().catch(() => {})
  }

  private log(event: string): void {
    this.deps.log?.(event)
  }

  private drop(): void {
    if (!this.stream) return
    for (const track of this.stream.getAudioTracks()) track.stop()
    this.stream = null
  }
}

function isLive(stream: InputStream): boolean {
  return stream.getAudioTracks().some((track) => track.readyState === 'live')
}

/** Changes when an input appears or disappears, or the system default moves (its label names the device). */
function inputsKey(inputs: AudioInputDevice[]): string {
  return inputs.map((input) => `${input.deviceId}\u0000${input.label}`).join('\n')
}
