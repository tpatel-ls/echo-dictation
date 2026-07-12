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

const CSV_HEADERS = [
  'created_at',
  'status',
  'text',
  'raw_text',
  'duration_ms',
  'word_count',
  'latency_ms',
  'app_context',
  'model'
]

export function serializeTranscriptCsv(transcripts: Transcript[]): string {
  const rows = transcripts.map((transcript) => [
    new Date(transcript.created_at).toISOString(),
    transcript.status,
    transcript.cleaned_text ?? transcript.raw_text,
    transcript.raw_text,
    transcript.duration_ms,
    transcript.word_count,
    transcript.latency_ms,
    transcript.app_context,
    transcript.model
  ].map(csvCell).join(','))
  return [CSV_HEADERS.join(','), ...rows].join('\r\n') + '\r\n'
}

function csvCell(value: string | number): string {
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}
