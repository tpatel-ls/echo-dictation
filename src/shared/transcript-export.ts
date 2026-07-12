import type { Transcript, TranscriptStatus } from './types'

export interface PortableTranscript {
  createdAt: string
  text: string
  rawText: string
  status: TranscriptStatus
  durationMs: number
  wordCount: number
  latencyMs: number
  appContext: string
  model: string
}

export interface TranscriptJsonExport {
  version: 1
  exportedAt: string
  transcripts: PortableTranscript[]
}

export function serializeTranscriptJson(
  transcripts: Transcript[],
  exportedAt = Date.now()
): TranscriptJsonExport {
  return {
    version: 1,
    exportedAt: new Date(exportedAt).toISOString(),
    transcripts: transcripts.map((transcript) => ({
      createdAt: new Date(transcript.created_at).toISOString(),
      text: transcript.cleaned_text ?? transcript.raw_text,
      rawText: transcript.raw_text,
      status: transcript.status,
      durationMs: transcript.duration_ms,
      wordCount: transcript.word_count,
      latencyMs: transcript.latency_ms,
      appContext: transcript.app_context,
      model: transcript.model
    }))
  }
}
