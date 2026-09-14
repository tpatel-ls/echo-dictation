import type { AccuracyMode, Settings } from '@shared/types'
import {
  assessTranscript,
  chooseTranscript,
  type TranscriptCandidate
} from '@shared/transcript-quality'
import { isDeterministicModel } from '@shared/live-preview'
import { normalizeSpokenForms } from '@shared/spoken-forms'
import { adjudicate } from './adjudicator'
import { transcribe } from './whisper'

export type { AccuracyMode }
export { isDeterministicModel }

export interface SecondaryRecognizer {
  transcribe(wavPath: string, locale: 'en-US'): Promise<TranscriptCandidate | null>
}

export interface RecognitionAudio {
  path: string
  buffer: ArrayBuffer
  /** Recording length lets balanced mode overlap independent long-form decodes. */
  durationMs?: number
}

export interface AccuracyRequest {
  settings: Pick<
    Settings,
    'accuracyMode' | 'whisperBaseUrl' | 'whisperModel' | 'claudeBaseUrl' | 'claudeModel' | 'accuracyModel'
  > &
    Partial<Pick<Settings, 'crossCheckModels' | 'adjudicatorModel'>>
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
  /** A cross-check model on the same endpoint; absent means the main model. */
  model?: string
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
  /** Publishes the first decode so formatting can overlap the remaining accuracy checks. */
  onPrimary?: (candidate: TranscriptCandidate) => void
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
const BALANCED_FAST_PATH_WORDS = 12
const PARALLEL_ENSEMBLE_MIN_AUDIO_MS = 5_000
/** Canary-Qwen's LLM decoder costs ~300 ms on a short phrase but seconds on a paragraph. */
const SLOW_CROSS_CHECK_MAX_AUDIO_MS = 6_000
const CROSS_CHECK_TIMEOUT_MS = 4_000

/** Cross-check models worth waiting for on this recording. */
export function crossCheckModelsFor(list: string | undefined, durationMs: number | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
    .filter((model) => !/canary/i.test(model) || (durationMs ?? Infinity) < SLOW_CROSS_CHECK_MAX_AUDIO_MS)
}

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
      decodePrimary(wav, request, primary, deps),
      decodeRemote(wav, request, primary, 'remote-recovery', 0.3, deps.now),
      decodeRemote(wav, request, primary, 'remote-recovery', 0.3, deps.now),
      decodeRemote(wav, request, primary, 'remote-recovery', 0.3, deps.now),
      decodeRemote(wav, request, primary, 'remote-recovery', 0.8, deps.now),
      nativeWithTimeout(wav, deps)
    ])
    collectSettled(settled, candidates, errors)
    return finalize(candidates, request, deps, errors)
  }

  // Independent models make independent mistakes, unlike temperature samples of one model. Decode
  // them all at once so the wait is the slowest model, not the sum.
  const crossCheck = mode === 'balanced' ? crossCheckModelsFor(request.settings.crossCheckModels, wav.durationMs) : []
  if (crossCheck.length) {
    const settled = await Promise.allSettled([
      decodePrimary(wav, request, primary, deps),
      ...crossCheck.map((model) => decodeRemote(wav, request, primary, 'remote-recovery', 0, deps.now, model))
    ])
    collectSettled(settled, candidates, errors)
    return finalizeCrossCheck(candidates, request, deps, errors)
  }

  // One decode is the whole answer: Fast opts out of recovery, and a deterministic recognizer returns
  // identical text for every re-decode, so extra samples would only cost GPU time.
  if (mode === 'fast' || isDeterministicModel(request.settings.whisperModel)) {
    candidates.push(await decodePrimary(wav, request, primary, deps))
    return finalize(candidates, request, deps, errors)
  }

  // Long recordings are certain to need the balanced accuracy ensemble. Starting all three
  // independent decodes at release removes an entire serial GB10 round trip.
  if ((wav.durationMs ?? 0) >= PARALLEL_ENSEMBLE_MIN_AUDIO_MS) {
    const settled = await Promise.allSettled([
      decodePrimary(wav, request, primary, deps),
      decodeRemote(wav, request, primary, 'remote-recovery', 0.3, deps.now),
      decodeRemote(wav, request, primary, 'remote-recovery', 0.8, deps.now)
    ])
    collectSettled(settled, candidates, errors)
    return finalize(candidates, request, deps, errors)
  }

  const primaryCandidate = await decodePrimary(wav, request, primary, deps)
  candidates.push(primaryCandidate)
  const primaryGrade = assessTranscript(primaryCandidate.text, qualityOptions(request)).grade
  if (primaryGrade === 'clean' && transcriptWordCount(primaryCandidate.text) <= BALANCED_FAST_PATH_WORDS) {
    return finalize(candidates, request, deps, errors)
  }

  const settled = await Promise.allSettled([
    decodeRemote(wav, request, primary, 'remote-recovery', 0.3, deps.now),
    decodeRemote(wav, request, primary, 'remote-recovery', 0.8, deps.now)
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
  now: (() => number) | undefined,
  model?: string
): Promise<TranscriptCandidate> {
  const started = timestamp(now)
  const text = await primary(wav, request, { temperature, prompt: request.prompt, ...(model ? { model } : {}) })
  // Models disagree on "seven P R s" vs "7 PRs"; compare and pick on written forms.
  return { source, text: normalizeSpokenForms(text), elapsedMs: timestamp(now) - started, ...(model ? { model } : {}) }
}

async function finalizeCrossCheck(
  candidates: TranscriptCandidate[],
  request: AccuracyRequest,
  deps: Partial<RecognitionDeps>,
  errors: unknown[]
): Promise<RecognitionOutcome> {
  const options = qualityOptions(request)
  const grades = candidates.map((candidate) => assessTranscript(candidate.text, options).grade)
  const clean = candidates.filter((_, index) => grades[index] === 'clean')
  // Canary often returns unpunctuated lowercase text, which grades as suspicious formatting but is
  // still a valid vote on the words; the best-punctuated member of the agreeing group is pasted.
  // Different models spell the same words differently ("how's" / "how is"); vote on the words.
  const consensus = chooseExactConsensus(
    candidates.filter((_, index) => grades[index] !== 'reject'),
    options,
    2,
    normalizeForSupport
  )
  if (consensus) return { winner: consensus, candidates }

  // Three short hypotheses with no majority is where one misheard word ("my" vs "mic") changes the
  // meaning, so it earns the adjudicator call. Long dictations keep the main model instead of waiting.
  if (candidates.length >= 3 && hasMeaningfulDisagreement(candidates)) {
    const adjudicated = await runAdjudicator([...candidates], request, deps).catch(() => null)
    if (
      adjudicated &&
      assessTranscript(adjudicated, options).grade === 'clean' &&
      isSupportedAdjudication(adjudicated, candidates, false)
    ) {
      const candidate: TranscriptCandidate = { source: 'adjudicated', text: adjudicated, elapsedMs: 0 }
      candidates.push(candidate)
      return { winner: candidate, candidates }
    }
  }

  const main = candidates.find((candidate) => candidate.source === 'remote-primary')
  if (main && assessTranscript(main.text, options).grade === 'clean') return { winner: main, candidates }
  const winner = chooseTranscript(clean.length ? clean : candidates, options)
  if (winner) return { winner, candidates }
  if (!candidates.length && errors.length) throw errors[0]
  throw new LowConfidenceRecognitionError()
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
  const consensus = chooseExactConsensus(
    clean,
    options,
    request.settings.accuracyMode === 'maximum' ? 3 : 2
  )
  if (consensus) return { winner: consensus, candidates }
  if (request.settings.accuracyMode === 'balanced') {
    const fuzzyConsensus = chooseFuzzyConsensus(clean, options)
    if (fuzzyConsensus) return { winner: fuzzyConsensus, candidates }
  }
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
  options: { language: 'en'; glossary: string[] },
  minimumVotes = 2,
  keyOf: (text: string) => string = normalize
): TranscriptCandidate | null {
  const groups = new Map<string, TranscriptCandidate[]>()
  for (const candidate of candidates) {
    const key = keyOf(candidate.text)
    if (!key) continue
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }

  const consensusGroups = [...groups.values()].filter((group) => group.length >= minimumVotes)
  consensusGroups.sort((a, b) => b.length - a.length)
  if (!consensusGroups.length) return null
  const strongest = consensusGroups[0]
  const bestPunctuation = Math.max(...strongest.map((candidate) => punctuationScore(candidate.text)))
  return chooseTranscript(
    strongest.filter((candidate) => punctuationScore(candidate.text) === bestPunctuation),
    options
  )
}

/**
 * Long hypotheses that differ by only a word or two do not need another network model. Pick the
 * medoid candidate (the one closest to every other candidate) only when every pair agrees strongly.
 * Short commands stay out of this path because a single word such as "on" vs "off" is material.
 */
function chooseFuzzyConsensus(
  candidates: TranscriptCandidate[],
  options: { language: 'en'; glossary: string[] }
): TranscriptCandidate | null {
  if (candidates.length < 3 || candidates.some((candidate) => transcriptWordCount(candidate.text) < 50)) {
    return null
  }

  const normalized = candidates.map((candidate) => normalizeForSupport(candidate.text))
  const scores = candidates.map(() => 0)
  for (let left = 0; left < candidates.length; left++) {
    for (let right = left + 1; right < candidates.length; right++) {
      const similarity = supportSimilarity(normalized[left] ?? '', normalized[right] ?? '')
      if (similarity < 0.94) return null
      scores[left] = (scores[left] ?? 0) + similarity
      scores[right] = (scores[right] ?? 0) + similarity
    }
  }

  const bestScore = Math.max(...scores)
  return chooseTranscript(
    candidates.filter((_, index) => Math.abs((scores[index] ?? 0) - bestScore) < 0.0001),
    options
  )
}

async function decodePrimary(
  wav: RecognitionAudio,
  request: AccuracyRequest,
  primary: PrimaryRecognizer,
  deps: Partial<RecognitionDeps>
): Promise<TranscriptCandidate> {
  const candidate = await decodeRemote(wav, request, primary, 'remote-primary', 0, deps.now)
  try {
    deps.onPrimary?.(candidate)
  } catch {
    // Preview work is opportunistic and must never break recognition.
  }
  return candidate
}

function transcriptWordCount(text: string): number {
  return text.match(/[\p{L}\p{N}']+/gu)?.length ?? 0
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
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? ''
}

function punctuationScore(text: string): number {
  const sentenceMarks = text.match(/[.!?\u2026]/g)?.length ?? 0
  const clauseMarks = text.match(/[,;:]/g)?.length ?? 0
  return sentenceMarks * 10 + clauseMarks
}

function qualityOptions(request: AccuracyRequest): { language: 'en'; glossary: string[] } {
  return { language: 'en', glossary: request.glossary }
}

function timestamp(now: (() => number) | undefined): number {
  return now ? now() : Date.now()
}

const defaultPrimary: PrimaryRecognizer = (wav, request, opts) =>
  transcribe(
    wav.buffer,
    opts.model ? { ...request.settings, whisperModel: opts.model } : request.settings,
    request.whisperApiKey,
    undefined,
    {
      prompt: opts.prompt,
      temperature: opts.temperature,
      // A cross-check vote is optional: never let a slow or failing extra model hold up the paste.
      ...(opts.model ? { retries: 0, timeoutMs: CROSS_CHECK_TIMEOUT_MS } : {})
    }
  )

const defaultAdjudicator: AdjudicatorRecognizer = (candidates, request) =>
  adjudicate(
    candidates,
    request.appContext,
    request.settings,
    request.claudeApiKey,
    undefined,
    request.glossary
  )
