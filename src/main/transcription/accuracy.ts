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
    'accuracyMode' | 'whisperBaseUrl' | 'whisperModel' | 'claudeBaseUrl' | 'claudeModel' | 'accuracyModel'
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
  temperature: 0 | 0.3 | 0.8
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
      decodeRemote(wav, request, primary, 'remote-recovery', 0.3, deps.now),
      decodeRemote(wav, request, primary, 'remote-recovery', 0.3, deps.now),
      decodeRemote(wav, request, primary, 'remote-recovery', 0.3, deps.now),
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
    decodeRemote(wav, request, primary, 'remote-recovery', 0.3, deps.now),
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
  temperature: 0 | 0.3 | 0.8,
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
  const disagreement = candidates.length > 1 && hasMeaningfulDisagreement(candidates)
  let acceptedAdjudication = false

  if (disagreement) {
    const adjudicated = await runAdjudicator([...candidates], request, deps).catch(() => null)
    if (
      adjudicated &&
      assessTranscript(adjudicated, options).grade === 'clean' &&
      isSupportedAdjudication(adjudicated, candidates, Boolean(deps.secondary))
    ) {
      const candidate: TranscriptCandidate = { source: 'adjudicated', text: adjudicated, elapsedMs: 0 }
      clean.push(candidate)
      candidates.push(candidate)
      acceptedAdjudication = true
    }
  }

  if (request.settings.accuracyMode === 'maximum' && disagreement && !acceptedAdjudication) {
    const consensus = chooseExactConsensus(clean, options)
    if (consensus) return { winner: consensus, candidates }
    throw new LowConfidenceRecognitionError()
  }

  // Fast/Balanced are availability-first: after bounded rescue, keep a usable suspicious English
  // hypothesis instead of dropping the dictation. Deterministic rejects (foreign script, decoder
  // garbage, assistant replies, or empty output) remain ineligible. Maximum stays fail-closed.
  const winner = chooseTranscript(
    clean.length || request.settings.accuracyMode === 'maximum' ? clean : candidates,
    options
  )
  if (winner) return { winner, candidates }
  if (!candidates.length && errors.length) throw errors[0]
  throw new LowConfidenceRecognitionError()
}

function isSupportedAdjudication(
  text: string,
  candidates: TranscriptCandidate[],
  secondaryExpected: boolean
): boolean {
  const adjudicated = normalizeForSupport(text)
  if (!adjudicated) return false
  let remoteSupport = 0
  let nativeSupport = false
  let hasNativeCandidate = false
  for (const candidate of candidates) {
    const supported = supportSimilarity(adjudicated, normalizeForSupport(candidate.text)) >= 0.72
    if (candidate.source === 'native') {
      hasNativeCandidate = true
      nativeSupport ||= supported
    } else if (candidate.source !== 'adjudicated' && supported) {
      remoteSupport++
    }
  }

  if (hasNativeCandidate) return nativeSupport || remoteSupport >= 2
  return remoteSupport >= (secondaryExpected ? 2 : 1)
}

function normalizeForSupport(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\bi'm\b/g, 'i am')
    .replace(/\b(he|how|it|she|that|there|what|where|who)'s\b/g, '$1 is')
    .replace(/\bcan't\b/g, 'cannot')
    .replace(/\bwon't\b/g, 'will not')
    .replace(/n't\b/g, ' not')
    .replace(/'re\b/g, ' are')
    .replace(/'ve\b/g, ' have')
    .replace(/'ll\b/g, ' will')
    .match(/[\p{L}\p{N}]+/gu)
    ?.join(' ') ?? ''
}

function supportSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const aTokens = a.split(' ')
  const bTokens = b.split(' ')
  const remaining = new Map<string, number>()
  for (const token of bTokens) remaining.set(token, (remaining.get(token) ?? 0) + 1)
  let overlap = 0
  for (const token of aTokens) {
    const count = remaining.get(token) ?? 0
    if (count > 0) {
      overlap++
      remaining.set(token, count - 1)
    }
  }
  const tokenDice = (2 * overlap) / (aTokens.length + bTokens.length)
  const charSimilarity = 1 - editDistance(a, b) / Math.max(a.length, b.length)
  return Math.max(tokenDice, charSimilarity)
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return previous[b.length] ?? b.length
}

function chooseExactConsensus(
  candidates: TranscriptCandidate[],
  options: { language: 'en'; glossary: string[] }
): TranscriptCandidate | null {
  const groups = new Map<string, TranscriptCandidate[]>()
  for (const candidate of candidates) {
    const key = normalize(candidate.text)
    if (!key) continue
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }

  const consensusGroups = [...groups.values()].filter((group) => group.length >= 2)
  consensusGroups.sort((a, b) => b.length - a.length)
  return consensusGroups.length ? chooseTranscript(consensusGroups[0], options) : null
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
