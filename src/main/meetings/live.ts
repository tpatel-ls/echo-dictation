import { applyDictionary } from '@shared/dictionary'
import { int16ToWav, isSilentChunk, planLiveCut } from '@shared/meeting-audio'
import { isBleed } from '@shared/meeting-transcript'
import {
  MEETING_SAMPLE_RATE,
  OTHERS_SPEAKER_KEY,
  SELF_SPEAKER_KEY,
  type MeetingChannel,
  type MeetingSegment
} from '@shared/meeting-types'
import type { DictionaryEntry } from '@shared/types'
import type { NewSegment } from '../store/meetings'
import { MIC_PAUSE_MARGIN_SAMPLES, type MicPauseSpan } from './pcm-file'

// The live transcript: every cycle (2 s, driven by the controller) the newly recorded audio of
// both channels is cut into chunks at pauses, silent chunks are skipped, and the rest go to the
// fast live model one at a time per channel. A mic chunk that only repeats what the far end said
// at the same moment (the call leaking from the speakers into the mic) is dropped. A failed chunk
// is skipped; nothing here can stop the recording. While the mic is paused its audio is silenced
// here too (with the second before the pause), including anything already queued or in flight.

/** Mic and others text overlapping within this much of each other are compared for bleed. */
const BLEED_TOLERANCE_MS = 1500
/** Others text older than this (behind the newest mic chunk) can no longer matter for bleed. */
const OTHERS_MEMORY_MS = 120_000

export interface PcmSource {
  read(maxSamples?: number): Int16Array
}

export interface LiveDeps {
  mic: PcmSource
  others: PcmSource
  /** Transcribe one chunk with the live model (timeout and retries are the caller's). */
  transcribe: (wav: ArrayBuffer) => Promise<string>
  dictionary: () => DictionaryEntry[]
  /** Store a live segment (pass 'live'); returns the stored row. */
  append: (segment: NewSegment) => MeetingSegment
  onSegment: (segment: MeetingSegment) => void
  /** Diagnostic log; never given transcript text. */
  log: (message: string) => void
}

interface Chunk {
  startMs: number
  endMs: number
  /** Sample index (from the start of the recording) of samples[0]. */
  startSample: number
  samples: Int16Array
  silent: boolean
  /** Superseded by a silenced copy (a pause overlapped it): its text is thrown away. */
  stale: boolean
}

interface ChannelState {
  channel: MeetingChannel
  source: PcmSource
  pending: Int16Array
  /** Sample index (from the start of the recording) of pending[0]. */
  pendingStart: number
  queue: Chunk[]
  busy: Promise<void> | null
  inflight: Chunk | null
  /** Everything recorded before this has been transcribed, skipped or has failed. */
  doneThroughMs: number
}

interface HeldMic {
  chunk: Chunk
  startMs: number
  endMs: number
  text: string
  /** The cycle during which the text arrived; it waits at most until the next one. */
  cycle: number
}

/** Silence (in place) the sample ranges in `samples`, whose first sample is index `offset`. */
function silenceRanges(samples: Int16Array, ranges: MicPauseSpan[], offset: number): void {
  for (const r of ranges) {
    const from = Math.max(0, r.from - offset)
    const to = r.to === null ? samples.length : Math.min(samples.length, r.to - offset)
    if (to > from) samples.fill(0, from, to)
  }
}

function concat(a: Int16Array, b: Int16Array): Int16Array {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const out = new Int16Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function describeError(e: unknown): string {
  const err = e as { name?: string; status?: number }
  return `${err?.name ?? 'Error'}${err?.status ? ` ${err.status}` : ''}`
}

export class LiveTranscriber {
  private readonly mic: ChannelState
  private readonly others: ChannelState
  private held: HeldMic[] = []
  private recentOthers: Array<{ startMs: number; endMs: number; text: string }> = []
  private cycle = 0
  private cancelled = false
  /** Mic pauses so far (sample indexes); audio in them never reaches the live model. */
  private pauses: MicPauseSpan[] = []
  /** Where the meeting ended (the recording ran on for the end grace); null while it goes on. */
  private endSample: number | null = null

  constructor(private readonly deps: LiveDeps) {
    this.mic = this.channel('mic', deps.mic)
    this.others = this.channel('others', deps.others)
  }

  /** One cycle: take in new audio, cut chunks at pauses, start transcriptions, settle held mic text. */
  tick(): void {
    if (this.cancelled) return
    this.cycle++
    for (const ch of [this.others, this.mic]) {
      this.take(ch)
      this.cut(ch, false)
      this.pump(ch)
    }
    this.settle(false)
  }

  /** At stop: the rest of both files goes, every transcription finishes, every held mic chunk is decided. */
  async flush(): Promise<void> {
    if (this.cancelled) return
    this.cycle++
    for (const ch of [this.others, this.mic]) {
      this.take(ch)
      this.cut(ch, false)
      this.cut(ch, true)
      this.pump(ch)
    }
    await this.idle()
    this.settle(true)
  }

  /**
   * The mic channel was paused (or resumed) at mic sample `at`. On pause, the audio before the pause
   * point (less the margin) goes out as its own chunk, and every later mic sample, whether pending,
   * queued, in flight or awaiting the bleed check, is silenced, so nothing said around or during
   * the pause reaches the transcript.
   */
  setMicPaused(paused: boolean, at: number): void {
    if (this.cancelled) return
    const open = this.pauses.at(-1)
    if (!paused) {
      if (open && open.to === null) open.to = Math.max(open.from, at)
      return
    }
    if (open && open.to === null) return
    this.pauses.push({ from: Math.max(0, at), to: null })
    this.silenceFrom(this.mic, Math.max(0, at - MIC_PAUSE_MARGIN_SAMPLES))
  }

  /**
   * The meeting ended at sample `at` (the recording ran on through the end grace): nothing from
   * there on, on either channel, is sent to the model or stored.
   */
  endAt(at: number): void {
    if (this.cancelled) return
    this.endSample = Math.max(0, at)
    for (const ch of [this.others, this.mic]) this.silenceFrom(ch, this.endSample)
  }

  /**
   * Apply the channel's silenced ranges from sample `from` on: the pending audio before it goes out
   * as its own chunk, and every later sample, whether pending, queued, in flight or awaiting the
   * bleed check, is silenced (a chunk already sent or answered is sent again, silenced).
   */
  private silenceFrom(ch: ChannelState, from: number): void {
    this.take(ch)
    const cutAt = from - ch.pendingStart
    if (cutAt > 0 && cutAt < ch.pending.length) this.queueCut(ch, cutAt)
    silenceRanges(ch.pending, this.ranges(ch), ch.pendingStart)
    for (const chunk of ch.queue) this.silence(ch, chunk)
    const redo: Chunk[] = []
    if (ch.inflight && this.overlaps(ch, ch.inflight)) {
      ch.inflight.stale = true
      redo.push(this.silenced(ch, ch.inflight))
    }
    if (ch.channel === 'mic') {
      this.held = this.held.filter((h) => {
        if (!this.overlaps(ch, h.chunk)) return true
        redo.push(this.silenced(ch, h.chunk))
        return false
      })
    }
    ch.queue.unshift(...redo.filter((c) => !c.silent))
    this.pump(ch)
  }

  /** The channel's silenced sample ranges: mic pauses (with the margin before each) and the end. */
  private ranges(ch: ChannelState): MicPauseSpan[] {
    const out: MicPauseSpan[] =
      ch.channel === 'mic' ? this.pauses.map((p) => ({ from: Math.max(0, p.from - MIC_PAUSE_MARGIN_SAMPLES), to: p.to })) : []
    if (this.endSample !== null) out.push({ from: this.endSample, to: null })
    return out
  }

  /** Discard: stop without storing anything more. In-flight requests finish and are ignored. */
  cancel(): void {
    this.cancelled = true
    this.held = []
    for (const ch of [this.mic, this.others]) {
      ch.queue = []
      ch.pending = new Int16Array(0)
    }
  }

  /** Resolves once no chunk is queued or being transcribed. */
  async idle(): Promise<void> {
    for (;;) {
      const busy = [this.mic.busy, this.others.busy].filter((b): b is Promise<void> => b !== null)
      if (busy.length === 0) {
        if (this.mic.queue.length === 0 && this.others.queue.length === 0) return
        this.pump(this.mic)
        this.pump(this.others)
        continue
      }
      await Promise.all(busy)
    }
  }

  private channel(channel: MeetingChannel, source: PcmSource): ChannelState {
    return { channel, source, pending: new Int16Array(0), pendingStart: 0, queue: [], busy: null, inflight: null, doneThroughMs: 0 }
  }

  private take(ch: ChannelState): void {
    try {
      const fresh = ch.source.read()
      const ranges = this.ranges(ch)
      if (ranges.length > 0) silenceRanges(fresh, ranges, ch.pendingStart + ch.pending.length)
      ch.pending = concat(ch.pending, fresh)
    } catch (e) {
      this.deps.log(`live ${ch.channel}: read failed (${describeError(e)})`)
    }
  }

  private cut(ch: ChannelState, final: boolean): void {
    for (;;) {
      const at = planLiveCut(ch.pending, final)
      if (at === null || at <= 0) return
      this.queueCut(ch, at)
      if (final) return
    }
  }

  /** Move the first `at` pending samples into a queued chunk. */
  private queueCut(ch: ChannelState, at: number): void {
    const samples = ch.pending.slice(0, at)
    const startSample = ch.pendingStart
    ch.pendingStart += at
    ch.pending = ch.pending.slice(at)
    ch.queue.push({
      startMs: Math.round((startSample * 1000) / MEETING_SAMPLE_RATE),
      endMs: Math.round((ch.pendingStart * 1000) / MEETING_SAMPLE_RATE),
      startSample,
      samples,
      silent: isSilentChunk(samples),
      stale: false
    })
  }

  private overlaps(ch: ChannelState, chunk: Chunk): boolean {
    const end = chunk.startSample + chunk.samples.length
    return this.ranges(ch).some((r) => end > r.from && (r.to === null || chunk.startSample < r.to))
  }

  /** Silence a chunk's paused (or after-the-end) part in place. */
  private silence(ch: ChannelState, chunk: Chunk): void {
    if (!this.overlaps(ch, chunk)) return
    silenceRanges(chunk.samples, this.ranges(ch), chunk.startSample)
    chunk.silent = isSilentChunk(chunk.samples)
  }

  /** A fresh, silenced copy of a chunk whose text can no longer be used. */
  private silenced(ch: ChannelState, chunk: Chunk): Chunk {
    const copy: Chunk = { ...chunk, samples: chunk.samples.slice(), stale: false }
    this.silence(ch, copy)
    return copy
  }

  /** Start the channel's next chunk unless one is already in flight: one request at a time per channel. */
  private pump(ch: ChannelState): void {
    while (!ch.busy && ch.queue.length > 0) {
      const chunk = ch.queue.shift()!
      if (chunk.silent) {
        ch.doneThroughMs = chunk.endMs
        continue
      }
      ch.inflight = chunk
      ch.busy = this.transcribeChunk(ch, chunk).finally(() => {
        ch.busy = null
        ch.inflight = null
        ch.doneThroughMs = chunk.endMs
        if (this.cancelled) return
        this.pump(ch)
        this.settle(false)
      })
    }
  }

  private async transcribeChunk(ch: ChannelState, chunk: Chunk): Promise<void> {
    let text: string
    try {
      text = await this.deps.transcribe(int16ToWav(chunk.samples))
    } catch (e) {
      const seconds = ((chunk.endMs - chunk.startMs) / 1000).toFixed(1)
      this.deps.log(`live ${ch.channel}: ${seconds} s chunk skipped (${describeError(e)})`)
      return
    }
    if (this.cancelled || chunk.stale) return
    let cleaned = text.trim()
    try {
      cleaned = applyDictionary(cleaned, this.deps.dictionary()).text.trim()
    } catch {
      /* the transcript works without the dictionary */
    }
    if (!cleaned) return
    if (ch.channel === 'others') {
      this.recentOthers.push({ startMs: chunk.startMs, endMs: chunk.endMs, text: cleaned })
      this.store('others', chunk.startMs, chunk.endMs, cleaned)
    } else {
      this.held.push({ chunk, startMs: chunk.startMs, endMs: chunk.endMs, text: cleaned, cycle: this.cycle })
    }
  }

  /**
   * Decide held mic chunks, in order: once the others channel is done past the chunk (plus the
   * tolerance), after one more cycle, or at stop (`force`).
   */
  private settle(force: boolean): void {
    while (this.held.length > 0) {
      const h = this.held[0]
      const ready = force || this.others.doneThroughMs >= h.endMs + BLEED_TOLERANCE_MS || this.cycle > h.cycle
      if (!ready) return
      this.held.shift()
      const near = this.recentOthers.filter(
        (o) => o.startMs < h.endMs + BLEED_TOLERANCE_MS && o.endMs > h.startMs - BLEED_TOLERANCE_MS
      )
      if (isBleed(h.text, near.map((o) => o.text))) {
        this.deps.log('live mic: dropped a chunk that repeats the others channel (bleed)')
      } else {
        this.store('mic', h.startMs, h.endMs, h.text)
      }
      this.recentOthers = this.recentOthers.filter((o) => o.endMs > h.endMs - OTHERS_MEMORY_MS)
    }
  }

  private store(channel: MeetingChannel, startMs: number, endMs: number, text: string): void {
    const segment = this.deps.append({
      start_ms: startMs,
      end_ms: endMs,
      channel,
      speaker_key: channel === 'mic' ? SELF_SPEAKER_KEY : OTHERS_SPEAKER_KEY,
      text,
      pass: 'live'
    })
    this.deps.onSegment(segment)
  }
}
