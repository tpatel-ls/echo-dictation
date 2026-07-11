import type { AccuracyMode, Settings } from '@shared/types'
import {
  assessTranscript,
  chooseTranscript,
  type TranscriptCandidate
} from '@shared/transcript-quality'
import { adjudicate } from './adjudicator'
import { transcribe } from './whisper'

export type { AccuracyMode }

export interface SecondaryRecognizer {
  transcribe(wavPath: string, locale: 'en-US'): Promise<TranscriptCandidate | null>
}

export interface RecognitionAudio {
  path: string
  buffer: ArrayBuffer
}

export interface AccuracyRequest {
  settings: Pick<
    Settings,
    'accuracyMode' | 'whisperBaseUrl' | 'whisperModel' | 'claudeBaseUrl' | 'accuracyModel'
  >
  whisperApiKey: string
  claudeApiKey: string
  appContext: string
  glossary: string[]
  prompt?: string
}

export interface RecognitionOutcome {
  winner: TranscriptCandidate
  candidates: TranscriptCandidate[]
}

export interface RemoteDecodeOptions {
  temperature: 0 | 0.8
  prompt?: string
}

export type PrimaryRecognizer = (
  wav: RecognitionAudio,
  request: AccuracyRequest,
  opts: RemoteDecodeOptions
) => Promise<string>

export type AdjudicatorRecognizer = (
  candidates: TranscriptCandidate[],
  request: AccuracyRequest
) => Promise<string | null>

export interface RecognitionDeps {
  primary: PrimaryRecognizer
  adjudicator?: AdjudicatorRecognizer
  secondary?: SecondaryRecognizer
  nativeTimeoutMs?: number
  now?: () => number
}

export class LowConfidenceRecognitionError extends Error {
  constructor() {
    super('low confidence')
    this.name = 'LowConfidenceRecognitionError'
  }
}

export function isLowConfidenceRecognitionError(e: unknown): boolean {
  return e instanceof LowConfidenceRecognitionError
}

const NATIVE_TIMEOUT_MS = 1500

export async function recognizeAccurately(
  wav: RecognitionAudio,
  request: AccuracyRequest,
  deps: Partial<RecognitionDeps> = {}
): Promise<RecognitionOutcome> {
  const primary = deps.primary ?? defaultPrimary
  const candidates: TranscriptCandidate[] = []
  const errors: unknown[] = []
  const mode = request.settings.accuracyMode

  if (mode === 'maximum') {
    const settled = await Promise.allSettled([
      decodeRemote(wav, request, primary, 'remote-primary', 0, deps.now),
      decodeRemote(wav, request, primary, 'remote-recovery', 0.8, deps.now),
      nativeWithTimeout(wav, deps)
    ])
    collectSettled(settled, candidates, errors)
    return finalize(candidates, request, deps, errors)
  }

  const primaryCandidate = await decodeRemote(wav, request, primary, 'remote-primary', 0, deps.now)
  candidates.push(primaryCandidate)
  const primaryGrade = assessTranscript(primaryCandidate.text, qualityOptions(request)).grade
  if (mode === 'fast' || primaryGrade === 'clean') return finalize(candidates, request, deps, errors)

  const settled = await Promise.allSettled([
    decodeRemote(wav, request, primary, 'remote-recovery', 0.8, deps.now),
    nativeWithTimeout(wav, deps)
  ])
  collectSettled(settled, candidates, errors)
  return finalize(candidates, request, deps, errors)
}

async function decodeRemote(
  wav: RecognitionAudio,
  request: AccuracyRequest,
  primary: PrimaryRecognizer,
  source: 'remote-primary' | 'remote-recovery',
  temperature: 0 | 0.8,
  now: (() => number) | undefined
): Promise<TranscriptCandidate> {
  const started = timestamp(now)
  const text = await primary(wav, request, { temperature, prompt: request.prompt })
  return { source, text, elapsedMs: timestamp(now) - started }
}

async function nativeWithTimeout(
  wav: RecognitionAudio,
  deps: Partial<RecognitionDeps>
): Promise<TranscriptCandidate | null> {
  if (!deps.secondary) return null
  const timeoutMs = deps.nativeTimeoutMs ?? NATIVE_TIMEOUT_MS
  return withTimeout(deps.secondary.transcribe(wav.path, 'en-US'), timeoutMs).catch(() => null)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function collectSettled(
  settled: PromiseSettledResult<TranscriptCandidate | null>[],
  candidates: TranscriptCandidate[],
  errors: unknown[]
): void {
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      if (result.value) candidates.push(result.value)
    } else {
      errors.push(result.reason)
    }
  }
}

async function finalize(
  candidates: TranscriptCandidate[],
  request: AccuracyRequest,
  deps: Partial<RecognitionDeps>,
  errors: unknown[]
): Promise<RecognitionOutcome> {
  const options = qualityOptions(request)
  const clean = candidates.filter((candidate) => assessTranscript(candidate.text, options).grade === 'clean')
  if (clean.length && hasMeaningfulDisagreement(clean)) {
    const adjudicated = await runAdjudicator(clean, request, deps).catch(() => null)
    if (adjudicated && assessTranscript(adjudicated, options).grade === 'clean') {
      clean.push({ source: 'adjudicated', text: adjudicated, elapsedMs: 0 })
      candidates.push(clean[clean.length - 1])
    }
  }

  const winner = chooseTranscript(clean, options)
  if (winner) return { winner, candidates }
  if (!candidates.length && errors.length) throw errors[0]
  throw new LowConfidenceRecognitionError()
}

async function runAdjudicator(
  candidates: TranscriptCandidate[],
  request: AccuracyRequest,
  deps: Partial<RecognitionDeps>
): Promise<string | null> {
  const adjudicator = deps.adjudicator ?? defaultAdjudicator
  if (!request.claudeApiKey || !request.settings.claudeBaseUrl) return null
  return adjudicator(candidates, request)
}

function hasMeaningfulDisagreement(candidates: TranscriptCandidate[]): boolean {
  const normalized = new Set(candidates.map((candidate) => normalize(candidate.text)).filter(Boolean))
  return normalized.size > 1
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

function qualityOptions(request: AccuracyRequest): { language: 'en'; glossary: string[] } {
  return { language: 'en', glossary: request.glossary }
}

function timestamp(now: (() => number) | undefined): number {
  return now ? now() : Date.now()
}

const defaultPrimary: PrimaryRecognizer = (wav, request, opts) =>
  transcribe(wav.buffer, request.settings, request.whisperApiKey, undefined, {
    prompt: opts.prompt,
    temperature: opts.temperature
  })

const defaultAdjudicator: AdjudicatorRecognizer = (candidates, request) =>
  adjudicate(
    candidates,
    request.appContext,
    request.settings,
    request.claudeApiKey,
    undefined,
    request.glossary
  )
