// Microphone capture via AudioWorklet. Raw PCM frames are accumulated on the audio
// thread and handed back on stop(); per-frame RMS level is pushed to a callback for
// the waveform. Supports "warm" mode: keep the mic + context open between dictations
// so the first key-press has zero acquisition latency.

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
  private levelCb: (level: number) => void = () => {}

  sampleRate = 48000

  onLevel(cb: (level: number) => void): void {
    this.levelCb = cb
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
    if (!this.warm) this.releaseStream()
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
    // Non-exact constraints (no mandatory channelCount) for maximum device
    // compatibility; we take channel 0 in the worklet, so input channels don't matter.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
  }

  private releaseStream(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }
  }
}
