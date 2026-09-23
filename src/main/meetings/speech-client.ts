import type { DiarizationResult, DiarizedSpeaker, DiarizedTurn, SegmentTranscript } from '@shared/meeting-types'
import { joinUrl } from '../transcription/whisper'

/**
 * Client for the GB10 meeting routes behind the Bearer shim (gb10/shim.py):
 * `POST /audio/diarizations` (pyannote speaker turns + per-speaker voice embeddings) and
 * `POST /audio/segments` (decode many clips of one WAV with several models in one request).
 * Every response field is validated before it reaches the pipeline, so a half-deployed or
 * mismatched server fails loudly here instead of corrupting a transcript.
 */

export interface SpeechConn {
  /** Settings.whisperBaseUrl, i.e. the shim's `.../v1`. */
  baseUrl: string
  apiKey: string
}

export interface SpeechDeps {
  fetch: typeof fetch
  timeoutMs?: number
  delay?: (ms: number) => Promise<void>
}

export class SpeechRouteError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'SpeechRouteError'
  }
}

/** Matches the shim's own 1800 s wait on the diarizer, so a long meeting is never cut off first. */
const DIARIZE_TIMEOUT_MS = 30 * 60_000
const SEGMENTS_TIMEOUT_MS = 5 * 60_000
const RETRIES = 2

/** Speaker turns and one voice embedding per speaker for a 16 kHz mono WAV. */
export async function diarize(
  wav: ArrayBuffer,
  opts: { numSpeakers?: number; minSpeakers?: number; maxSpeakers?: number },
  conn: SpeechConn,
  deps: SpeechDeps = { fetch }
): Promise<DiarizationResult> {
  const hints: Array<[string, number | undefined]> = [
    ['num_speakers', opts.numSpeakers],
    ['min_speakers', opts.minSpeakers],
    ['max_speakers', opts.maxSpeakers]
  ]
  const body = await post(
    'audio/diarizations',
    () => {
      const form = wavForm(wav)
      for (const [name, value] of hints) if (value !== undefined) form.append(name, String(value))
      form.append('embeddings', 'true')
      return form
    },
    conn,
    deps,
    DIARIZE_TIMEOUT_MS
  )
  return parseDiarization(body)
}

/**
 * Decode each `[start, end]` clip of `wav` with every model in `models`. Results come back in the
 * order of `segments`; a segment the server returned nothing for gets `texts: {}`. `prompt` is a
 * comma list of keywords (names, company terms) for the models that take one (Granite, Whisper);
 * the others ignore it.
 */
export async function transcribeSegments(
  wav: ArrayBuffer,
  segments: Array<{ id: string; start: number; end: number }>,
  models: string[],
  conn: SpeechConn,
  deps: SpeechDeps = { fetch },
  prompt?: string
): Promise<SegmentTranscript[]> {
  if (segments.length === 0) return []
  const body = await post(
    'audio/segments',
    () => {
      const form = wavForm(wav)
      form.append('models', models.join(','))
      form.append('segments', JSON.stringify(segments.map(({ id, start, end }) => ({ id, start, end }))))
      if (prompt) form.append('prompt', prompt)
      return form
    },
    conn,
    deps,
    SEGMENTS_TIMEOUT_MS
  )
  const byId = parseSegmentResults(body)
  return segments.map(({ id }) => ({ id, texts: byId.get(id) ?? {} }))
}

// ── transport ─────────────────────────────────────────────────────────────────

function wavForm(wav: ArrayBuffer): FormData {
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  return form
}

/**
 * POST with retries: network errors and 5xx are retried up to twice with growing backoff; a 4xx
 * is a real client error and a timeout would only time out again, so neither is retried.
 */
async function post(
  path: string,
  makeForm: () => FormData,
  conn: SpeechConn,
  deps: SpeechDeps,
  defaultTimeoutMs: number
): Promise<unknown> {
  const url = joinUrl(conn.baseUrl, path)
  const timeoutMs = deps.timeoutMs ?? defaultTimeoutMs
  const delay = deps.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await attemptPost(url, makeForm(), conn.apiKey, deps.fetch, timeoutMs)
    } catch (e) {
      lastError = e
      if (!(e instanceof Retryable)) throw e
      if (attempt < RETRIES) await delay(1000 * 2 ** attempt)
    }
  }
  throw (lastError as Retryable).error
}

/** Wraps an error worth another attempt; `post` unwraps it before it escapes. */
class Retryable {
  constructor(readonly error: SpeechRouteError) {}
}

async function attemptPost(
  url: string,
  form: FormData,
  apiKey: string,
  fetchFn: typeof fetch,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  let res: Response
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    })
  } catch (e) {
    if (timedOut) throw new SpeechRouteError(`Speech server timed out after ${Math.round(timeoutMs / 1000)} s`)
    throw new Retryable(new SpeechRouteError(`Network error reaching the speech server: ${(e as Error).message}`))
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = new SpeechRouteError(`Speech server returned ${res.status}: ${errorMessage(text)}`, res.status)
    if (res.status >= 500) throw new Retryable(err)
    throw err
  }
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new SpeechRouteError(`Speech server returned a non-JSON body: ${text.slice(0, 200)}`)
  }
}

/** The shim's `{error:{message}}` shape when present, else the raw body (truncated). */
function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } }
    if (typeof parsed?.error?.message === 'string') return parsed.error.message
  } catch {
    // not JSON; fall through to the raw body
  }
  return body.slice(0, 200)
}

// ── validation ────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>

function malformed(what: string): never {
  throw new SpeechRouteError(`Malformed speech server response: ${what}`)
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finite(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) malformed(`${what} is not a finite number`)
  return v
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) malformed(`${what} is not a non-empty string`)
  return v
}

function parseDiarization(body: unknown): DiarizationResult {
  if (!isObj(body)) malformed('diarization is not an object')
  const duration = finite(body.duration, 'duration')
  if (duration < 0) malformed('duration is negative')
  const embeddingDim = finite(body.embedding_dim, 'embedding_dim')
  if (!Number.isInteger(embeddingDim) || embeddingDim < 0) malformed('embedding_dim is not a count')
  if (!Array.isArray(body.speakers)) malformed('speakers is not an array')
  if (!Array.isArray(body.segments)) malformed('segments is not an array')

  const speakers: DiarizedSpeaker[] = body.speakers.map((raw, i) => {
    if (!isObj(raw)) malformed(`speakers[${i}] is not an object`)
    const turns = finite(raw.turns, `speakers[${i}].turns`)
    if (!Number.isInteger(turns) || turns < 0) malformed(`speakers[${i}].turns is not a count`)
    return {
      id: str(raw.id, `speakers[${i}].id`),
      speechSeconds: finite(raw.speech_seconds, `speakers[${i}].speech_seconds`),
      turns,
      embedding: embedding(raw.embedding, embeddingDim)
    }
  })
  const known = new Set(speakers.map((s) => s.id))

  const segments: DiarizedTurn[] = body.segments.map((raw, i) => {
    if (!isObj(raw)) malformed(`segments[${i}] is not an object`)
    const start = finite(raw.start, `segments[${i}].start`)
    const end = finite(raw.end, `segments[${i}].end`)
    if (start < 0 || end < start) malformed(`segments[${i}] has an invalid time range`)
    const speaker = str(raw.speaker, `segments[${i}].speaker`)
    if (!known.has(speaker)) malformed(`segments[${i}] names unknown speaker ${speaker}`)
    return { start, end, speaker }
  })
  segments.sort((a, b) => a.start - b.start)

  return {
    duration,
    model: str(body.model, 'model'),
    embeddingModel: str(body.embedding_model, 'embedding_model'),
    embeddingDim,
    segments,
    speakers
  }
}

/** An embedding is usable only at the advertised size with every value finite; else null. */
function embedding(v: unknown, dim: number): number[] | null {
  if (!Array.isArray(v) || dim === 0 || v.length !== dim) return null
  return v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as number[]) : null
}

function parseSegmentResults(body: unknown): Map<string, Record<string, string>> {
  if (!isObj(body) || !Array.isArray(body.results)) malformed('results is not an array')
  const byId = new Map<string, Record<string, string>>()
  body.results.forEach((raw, i) => {
    if (!isObj(raw)) malformed(`results[${i}] is not an object`)
    const id = str(raw.id, `results[${i}].id`)
    if (!isObj(raw.texts)) malformed(`results[${i}].texts is not an object`)
    const texts: Record<string, string> = {}
    for (const [model, text] of Object.entries(raw.texts)) {
      if (typeof text !== 'string') malformed(`results[${i}].texts.${model} is not a string`)
      texts[model] = text
    }
    byId.set(id, texts)
  })
  return byId
}
