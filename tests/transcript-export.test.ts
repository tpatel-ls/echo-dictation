import { describe, expect, it } from 'vitest'
import { serializeTranscriptJson } from '../src/shared/transcript-export'
import type { Transcript } from '@shared/types'

const transcript: Transcript = {
  id: 42,
  created_at: Date.parse('2026-07-12T18:00:00.000Z'),
  raw_text: 'raw words',
  cleaned_text: 'Clean words.',
  duration_ms: 1250,
  word_count: 2,
  latency_ms: 320,
  app_context: 'Mail',
  model: 'whisper-1',
  status: 'ok',
  audio_path: '/private/audio.wav'
}

describe('serializeTranscriptJson', () => {
  it('creates a versioned portable export without local ids or audio paths', () => {
    const exported = serializeTranscriptJson([transcript], Date.parse('2026-07-12T19:00:00.000Z'))

    expect(exported).toEqual({
      version: 1,
      exportedAt: '2026-07-12T19:00:00.000Z',
      transcripts: [{
        createdAt: '2026-07-12T18:00:00.000Z',
        text: 'Clean words.',
        rawText: 'raw words',
        status: 'ok',
        durationMs: 1250,
        wordCount: 2,
        latencyMs: 320,
        appContext: 'Mail',
        model: 'whisper-1'
      }]
    })
    expect(JSON.stringify(exported)).not.toContain('/private/audio.wav')
    expect(exported.transcripts[0]).not.toHaveProperty('id')
  })

  it('uses raw text when no cleaned transcript exists', () => {
    const exported = serializeTranscriptJson([{ ...transcript, cleaned_text: null }], 0)
    expect(exported.transcripts[0].text).toBe('raw words')
  })
})
