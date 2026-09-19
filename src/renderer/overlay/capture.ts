// Microphone capture via AudioWorklet. Raw PCM frames are accumulated on the audio
// thread and handed back on stop(); per-frame RMS level is pushed to a callback for
// the waveform. Supports "warm" mode: keep the mic + context open between dictations
// so the first key-press has zero acquisition latency. MicStream keeps that held
// stream alive across device changes.

import type { AudioInputDevice } from './audio-device'
import { MicStream } from './mic-stream'

const WORKLET_SRC = `
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('pcm-processor', PCMProcessor)
`

/** A take shorter than this can end before its first frame lands, so it says nothing about the mic. */
const MIN_JUDGED_TAKE_MS = 150
/**
 * A healthy graph delivers ~99% of real time on a take this long. One that delivers far less has
 * stalled or lost its clock — e.g. the default output was the USB mic's own headphone jack, and it
 * was unplugged. (Rendering with no output device at all isn't the answer: on Windows Chromium's
 * fake sink runs at ~64% of real time.)
 */
const MIN_PACED_TAKE_MS = 1000
const MIN_REAL_TIME_SHARE = 0.85

export class MicCapture {
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private sink: GainNode | null = null
  private frames: Float32Array[] = []
  /** Whether any sample of the current take was non-zero. */
  private heardSound = false
  /** The current take acquired the mic and still owes it a release. */
  private holdingMic = false
  private connectedAt = 0
  /** The latest start(); stop() waits for it so a quick release never strands a half-built graph. */
  private starting: Promise<void> = Promise.resolve()
  private moduleAdded = false
  private mic = new MicStream<MediaStream>({
    listInputs: listAudioInputs,
    open: (deviceId) => navigator.mediaDevices.getUserMedia({ audio: constraints(deviceId) }),
    log: (event) => this.eventCb(event)
  })
  private levelCb: (level: number) => void = () => {}
  private frameCb: (frame: Float32Array, sampleRate: number) => void = () => {}
  private eventCb: (event: string) => void = () => {}
  private readonly onDeviceChange = (): void => {
    void this.mic.onDeviceChange().catch(() => {})
  }

  sampleRate = 48000

  constructor() {
    navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange)
  }

  dispose(): void {
    navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange)
    void this.mic.setWarm(false)
  }

  onLevel(cb: (level: number) => void): void {
    this.levelCb = cb
  }

  /** Every captured frame as it arrives — feeds the incremental live-preview buffer. */
  onFrame(cb: (frame: Float32Array, sampleRate: number) => void): void {
    this.frameCb = cb
  }

  /** Mic lifecycle events — what opened, and why it was reopened — for the diagnostic log. */
  onEvent(cb: (event: string) => void): void {
    this.eventCb = cb
  }

  setPreferredDevice(deviceId: string): void {
    this.mic.setPreferredDevice(deviceId)
  }

  /** Warm mode pre-opens the audio context + mic so the first dictation has no acquisition latency. */
  async setWarm(warm: boolean): Promise<void> {
    if (warm) {
      try {
        await this.ensureContext()
      } catch {
        /* start() will surface it when actually used */
      }
    }
    await this.mic.setWarm(warm)
  }

  start(): Promise<void> {
    this.starting = this.connect()
    return this.starting
  }

  private async connect(): Promise<void> {
    this.frames = []
    this.heardSound = false
    await this.ensureContext()
    const stream = await this.mic.acquire()
    this.holdingMic = true
    const ctx = this.ctx!
    this.source = ctx.createMediaStreamSource(stream)
    this.node = new AudioWorkletNode(ctx, 'pcm-processor')
    this.node.port.onmessage = (e: MessageEvent<Float32Array>): void => {
      const frame = e.data
      this.frames.push(frame)
      this.frameCb(frame, this.sampleRate)
      let sum = 0
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
      if (sum > 0) this.heardSound = true
      this.levelCb(Math.sqrt(sum / frame.length))
    }
    // Route through a muted gain to the destination so the worklet keeps pulling
    // audio without echoing the mic to the speakers.
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.node)
    this.node.connect(this.sink)
    this.sink.connect(ctx.destination)
    this.connectedAt = performance.now()
  }

  async stop(): Promise<{ frames: Float32Array[]; sampleRate: number }> {
    await this.starting.catch(() => {})
    const frames = this.frames
    this.frames = []
    try {
      this.source?.disconnect()
      this.node?.disconnect()
      this.sink?.disconnect()
    } catch {
      /* ignore */
    }
    this.source = null
    this.node = null
    this.sink = null
    this.levelCb(0)
    if (this.holdingMic) {
      this.holdingMic = false
      const heldMs = performance.now() - this.connectedAt
      const capturedMs = (frames.reduce((n, f) => n + f.length, 0) / this.sampleRate) * 1000
      const judged = heldMs >= MIN_JUDGED_TAKE_MS
      const stalled = frames.length === 0 || (heldMs >= MIN_PACED_TAKE_MS && capturedMs < heldMs * MIN_REAL_TIME_SHARE)
      if (judged && stalled) {
        this.eventCb(`take captured ${Math.round(capturedMs)}ms of ${Math.round(heldMs)}ms; rebuilding audio context`)
        void this.ctx?.close().catch(() => {})
        this.ctx = null
      }
      this.mic.release(judged ? this.heardSound : true)
    }
    return { frames, sampleRate: this.sampleRate }
  }

  private async ensureContext(): Promise<void> {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext()
      this.moduleAdded = false
    }
    if (this.ctx.state !== 'running') await this.ctx.resume()
    this.sampleRate = this.ctx.sampleRate
    if (!this.moduleAdded) {
      const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      await this.ctx.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      this.moduleAdded = true
    }
  }
}

async function listAudioInputs(): Promise<AudioInputDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => ({ deviceId: device.deviceId, label: device.label }))
}

function constraints(deviceId?: string): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    channelCount: { ideal: 1 },
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
}
