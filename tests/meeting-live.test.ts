import { describe, it, expect } from 'vitest'
import { LiveTranscriber, type LiveDeps, type PcmSource } from '../src/main/meetings/live'
import type { MeetingSegment } from '@shared/meeting-types'
import type { DictionaryEntry } from '@shared/types'
import type { NewSegment } from '../src/main/store/meetings'

const RATE = 16_000

/** Speech-like audio: a 220 Hz tone whose loudness swings at 4 Hz, so the VAD sees dips and peaks. */
function speech(seconds: number): Int16Array {
  const out = new Int16Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t)
    out[i] = Math.round(8000 * env * Math.sin(2 * Math.PI * 220 * t))
  }
  return out
}

function silence(seconds: number): Int16Array {
  return new Int16Array(Math.round(seconds * RATE))
}

class FakeSource implements PcmSource {
  private chunks: Int16Array[] = []
  push(samples: Int16Array): void {
    this.chunks.push(samples)
  }
  read(): Int16Array {
    const all = this.chunks
    this.chunks = []
    const total = all.reduce((n, c) => n + c.length, 0)
    const out = new Int16Array(total)
    let at = 0
    for (const c of all) {
      out.set(c, at)
      at += c.length
    }
    return out
  }
}

interface Call {
  seconds: number
  resolve: (text: string) => void
  reject: (e: Error) => void
}

function setup(dictionary: DictionaryEntry[] = []) {
  const mic = new FakeSource()
  const others = new FakeSource()
  const calls: Call[] = []
  const stored: MeetingSegment[] = []
  const emitted: MeetingSegment[] = []
  const logs: string[] = []
  // Each transcription waits for the test to answer it; the chunk length tells which chunk it is.
  const transcribe = (wav: ArrayBuffer): Promise<string> =>
    new Promise((resolve, reject) => calls.push({ seconds: (wav.byteLength - 44) / 2 / RATE, resolve, reject }))
  const deps: LiveDeps = {
    mic,
    others,
    transcribe,
    dictionary: () => dictionary,
    append: (seg: NewSegment) => {
      const row: MeetingSegment = { ...seg, id: stored.length + 1, meeting_id: 1, idx: stored.length }
      stored.push(row)
      return row
    },
    onSegment: (seg) => emitted.push(seg),
    log: (m) => logs.push(m)
  }
  const live = new LiveTranscriber(deps)
  return { live, mic, others, calls, stored, emitted, logs }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('LiveTranscriber', () => {
  it('waits for 12 s of audio, cuts at a pause, and continues from the cut', async () => {
    const { live, mic, calls, stored } = setup()
    mic.push(speech(6))
    live.tick()
    expect(calls).toHaveLength(0) // under 12 s pending

    mic.push(speech(4))
    mic.push(silence(0.5))
    mic.push(speech(4))
    live.tick()
    expect(calls).toHaveLength(1)
    // The quietest 300 ms window between 8 s and 14.5 s is the half second of silence at 10 s.
    expect(calls[0].seconds).toBeGreaterThan(10)
    expect(calls[0].seconds).toBeLessThan(10.5)
    calls[0].resolve('first part')
    await settle()
    live.tick() // the next cycle decides the held mic text (no others audio to compare)
    expect(stored.map((s) => [s.text, s.channel, s.speaker_key, s.pass, s.start_ms])).toEqual([
      ['first part', 'mic', 'me', 'live', 0]
    ])
    const cutMs = stored[0].end_ms

    const flushed = live.flush()
    // The rest after the cut goes at stop, starting exactly where the first chunk ended.
    expect(calls).toHaveLength(2)
    calls[1].resolve('second part')
    await flushed
    expect(stored[1]).toMatchObject({ text: 'second part', start_ms: cutMs, end_ms: 14_500 })
  })

  it('never sends a silent chunk', async () => {
    const { live, others, calls, stored } = setup()
    others.push(silence(13))
    live.tick()
    others.push(silence(3))
    await live.flush()
    expect(calls).toHaveLength(0)
    expect(stored).toHaveLength(0)
  })

  it('stores others text right away as the undiarized remote channel, dictionary applied', async () => {
    const { live, others, calls, stored, emitted } = setup([
      { id: 1, word: 'Whitmore', misheard: ['wit more'] } as unknown as DictionaryEntry
    ])
    others.push(speech(5))
    const flushed = live.flush()
    calls[0].resolve('  ask wit more  ')
    await flushed
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ channel: 'others', speaker_key: 'others', text: 'ask Whitmore', pass: 'live' })
    expect(emitted).toEqual(stored)
  })

  it('holds a mic chunk for the overlapping others chunk and drops it as bleed', async () => {
    const { live, mic, others, calls, stored, logs } = setup()
    mic.push(speech(5))
    others.push(speech(5))
    const flushed = live.flush()
    // others is queued first, mic second; answer mic first so it must wait for others.
    const othersCall = calls[0]
    const micCall = calls[1]
    micCall.resolve('we should ship the release on friday')
    await settle()
    expect(stored).toHaveLength(0) // held, not decided yet
    othersCall.resolve('We should ship the release on Friday.')
    await flushed
    expect(stored.map((s) => s.channel)).toEqual(['others'])
    expect(logs.some((l) => l.includes('bleed'))).toBe(true)
    expect(logs.join('\n')).not.toContain('friday')
  })

  it('keeps mic text that is not in the others channel', async () => {
    const { live, mic, others, calls, stored } = setup()
    mic.push(speech(5))
    others.push(speech(5))
    const flushed = live.flush()
    calls[1].resolve('I think Tuesday works better for me')
    calls[0].resolve('What day works for everyone?')
    await flushed
    expect(stored.map((s) => [s.channel, s.text])).toEqual([
      ['others', 'What day works for everyone?'],
      ['mic', 'I think Tuesday works better for me']
    ])
  })

  it('waits at most one cycle for the others channel before deciding', async () => {
    const { live, mic, others, calls, stored } = setup()
    mic.push(speech(14))
    others.push(speech(14))
    live.tick()
    expect(calls).toHaveLength(2)
    calls[1].resolve('something only I said') // mic; others still in flight
    await settle()
    expect(stored).toHaveLength(0)
    live.tick()
    expect(stored.map((s) => s.channel)).toEqual(['mic'])
  })

  it('skips a chunk whose transcription fails, logs no content, and carries on', async () => {
    const { live, mic, calls, stored, logs } = setup()
    mic.push(speech(14))
    live.tick()
    const err = Object.assign(new Error('Whisper returned 503: busy'), { name: 'TranscriptionError', status: 503 })
    calls[0].reject(err)
    await settle()
    expect(stored).toHaveLength(0)
    expect(logs.some((l) => l.includes('skipped') && l.includes('TranscriptionError 503'))).toBe(true)
    expect(logs.join('\n')).not.toContain('busy')

    const flushed = live.flush()
    expect(calls).toHaveLength(2) // the remainder is still transcribed
    calls[1].resolve('still here')
    await flushed
    expect(stored.map((s) => s.text)).toEqual(['still here'])
  })

  it('sends one request at a time per channel', async () => {
    const { live, mic, calls } = setup()
    mic.push(speech(29))
    mic.push(speech(29))
    live.tick()
    expect(calls).toHaveLength(1) // at least two chunks are cut, only one is in flight
    calls[0].resolve('one')
    await settle()
    expect(calls).toHaveLength(2)
  })

  it('stores nothing after cancel', async () => {
    const { live, others, calls, stored } = setup()
    others.push(speech(14))
    live.tick()
    live.cancel()
    calls[0].resolve('late text')
    await settle()
    await live.flush()
    expect(stored).toHaveLength(0)
  })
})

describe('LiveTranscriber: mic pause', () => {
  it('cuts the pending mic audio at the pause point and never sends what follows', async () => {
    const { live, mic, calls, stored } = setup()
    mic.push(speech(8)) // pending, under the 12 s needed for a regular cut
    live.tick()
    expect(calls).toHaveLength(0)
    // Paused at 6 s: 0-5 s (less the 1 s margin) goes out alone; 5-8 s is silenced.
    live.setMicPaused(true, 6 * RATE)
    expect(calls).toHaveLength(1)
    expect(calls[0].seconds).toBe(5)
    calls[0].resolve('before the pause')
    // Audio recorded while paused (the helper writes zeros, but even if it had not) is silenced.
    mic.push(speech(20))
    live.tick()
    await settle()
    live.tick()
    expect(calls).toHaveLength(1)
    // Resumed at 28 s: speech after that is transcribed again.
    live.setMicPaused(false, 28 * RATE)
    mic.push(speech(4))
    const flushed = live.flush()
    expect(calls).toHaveLength(2)
    calls[1].resolve('after the resume')
    await flushed
    expect(stored.map((s) => [s.text, s.start_ms, s.end_ms])).toEqual([
      ['before the pause', 0, 5000],
      // Chunks start in the silence before speech; this one ends with the resumed audio.
      ['after the resume', stored[1].start_ms, 32_000]
    ])
    expect(stored[1].start_ms).toBeGreaterThanOrEqual(5000)
  })

  it('re-sends a chunk that was in flight when the pause arrived, with the paused part silenced', async () => {
    const { live, mic, calls, stored } = setup()
    mic.push(speech(14))
    live.tick()
    expect(calls).toHaveLength(1)
    const firstLength = calls[0].seconds
    // The pause lands inside the in-flight chunk (the app muted just before the cut).
    live.setMicPaused(true, Math.round((firstLength - 0.5) * RATE))
    calls[0].resolve('text that includes the muted moment')
    await settle()
    expect(calls).toHaveLength(2) // the silenced copy
    expect(calls[1].seconds).toBe(firstLength)
    calls[1].resolve('text without it')
    await settle()
    await live.flush()
    expect(stored.map((s) => s.text)).toEqual(['text without it'])
  })

  it('drops mic text awaiting the bleed check when a pause overlaps it', async () => {
    const { live, mic, calls, stored } = setup()
    mic.push(speech(14))
    live.tick()
    calls[0].resolve('held text')
    await settle()
    expect(stored).toHaveLength(0) // held until the next cycle
    live.setMicPaused(true, 0) // pause covers the whole chunk
    await live.flush()
    expect(stored).toHaveLength(0)
    expect(calls).toHaveLength(1) // fully silenced: nothing to re-send
  })
})

describe('LiveTranscriber.endAt (the meeting ended before the recording stopped)', () => {
  it('never sends or stores audio recorded after the end, on either channel', async () => {
    const { live, others, calls, stored } = setup()
    others.push(speech(14))
    live.tick()
    expect(calls).toHaveLength(1) // the first ~8 s chunk is in flight
    // The call ended at 4 s; the recording ran on for the end grace.
    live.endAt(4 * RATE)
    calls[0].resolve('text that includes the time after the call')
    await settle()
    expect(calls).toHaveLength(2) // re-sent with everything after 4 s silenced
    calls[1].resolve('only the call')
    others.push(speech(10)) // recorded after the call ended
    await settle()
    const flushed = live.flush()
    await settle()
    // Nothing after the end is sent: every further chunk is silent.
    expect(calls).toHaveLength(2)
    await flushed
    expect(stored.map((s) => s.text)).toEqual(['only the call'])
  })
})
