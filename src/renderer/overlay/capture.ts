// Microphone capture via AudioWorklet. Raw PCM frames are accumulated on the audio
// thread and handed back on stop(); per-frame RMS level is pushed to a callback for
// the waveform. Supports "warm" mode: keep the mic + context open between dictations
// so the first key-press has zero acquisition latency.

import { resolveAudioDevice } from './audio-device'

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

export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private sink: GainNode | null = null
  private frames: Float32Array[] = []
  private moduleAdded = false
  private warm = false
  private recording = false
  private preferredDeviceId = ''
  private deviceChangedWhileRecording = false
  private levelCb: (level: number) => void = () => {}

  sampleRate = 48000

  onLevel(cb: (level: number) => void): void {
    this.levelCb = cb
  }

  setPreferredDevice(deviceId: string): void {
    if (deviceId === this.preferredDeviceId) return
    this.preferredDeviceId = deviceId
    if (this.recording) {
      this.deviceChangedWhileRecording = true
      return
    }
    this.releaseStream()
    if (this.warm) void this.prewarm().catch(() => {})
  }

  async setWarm(warm: boolean): Promise<void> {
    this.warm = warm
    if (warm) {
      try {
        await this.prewarm()
      } catch {
        /* mic unavailable — start() will surface it when actually used */
      }
    } else if (!this.recording) {
      this.releaseStream()
    }
  }

  /** Pre-open the audio context + mic so the first dictation has no acquisition latency. */
  async prewarm(): Promise<void> {
    await this.ensureContext()
    await this.ensureStream()
  }

  async start(): Promise<void> {
    this.frames = []
    await this.ensureContext()
    await this.ensureStream()
    this.recording = true
    const ctx = this.ctx!
    this.source = ctx.createMediaStreamSource(this.stream!)
    this.node = new AudioWorkletNode(ctx, 'pcm-processor')
    this.node.port.onmessage = (e: MessageEvent<Float32Array>): void => {
      const frame = e.data
      this.frames.push(frame)
      let sum = 0
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
      this.levelCb(Math.sqrt(sum / frame.length))
    }
    // Route through a muted gain to the destination so the worklet keeps pulling
    // audio without echoing the mic to the speakers.
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.node)
    this.node.connect(this.sink)
    this.sink.connect(ctx.destination)
  }

  async stop(): Promise<{ frames: Float32Array[]; sampleRate: number }> {
    const frames = this.frames
    this.frames = []
    this.recording = false
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
    if (this.deviceChangedWhileRecording) {
      this.deviceChangedWhileRecording = false
      this.releaseStream()
      if (this.warm) void this.prewarm().catch(() => {})
    } else if (!this.warm) {
      this.releaseStream()
    }
    return { frames, sampleRate: this.sampleRate }
  }

  private async ensureContext(): Promise<void> {
    if (!this.ctx) this.ctx = new AudioContext()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    this.sampleRate = this.ctx.sampleRate
    if (!this.moduleAdded) {
      const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      await this.ctx.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      this.moduleAdded = true
    }
  }

  private async ensureStream(): Promise<void> {
    if (this.stream) return
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
    const inputs = devices
      .filter((device) => device.kind === 'audioinput')
      .map((device) => ({ deviceId: device.deviceId, label: device.label }))
    const resolved = resolveAudioDevice(this.preferredDeviceId, inputs)
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints(resolved.deviceId) })
    } catch (error) {
      const name = (error as Error)?.name
      if (!resolved.deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw error
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints() })
    }
  }

  private releaseStream(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }
  }
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
