import type { Settings } from '@shared/types'

export interface WhisperDeps {
  fetch: typeof fetch
}

export interface WhisperOpts {
  retries?: number
  timeoutMs?: number
  delay?: (ms: number) => Promise<void>
  /** Dictionary bias prompt — nudges Whisper toward custom spellings. */
  prompt?: string
  temperature?: number
}

export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'TranscriptionError'
  }
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}

/**
 * POST a WAV buffer to an OpenAI-compatible `/audio/transcriptions` endpoint and
 * return the transcribed text. Retries transient failures (network errors, 5xx) so a
 * momentary tailnet blip doesn't lose a dictation; never retries 4xx (real client
 * errors). Each attempt is bounded by a timeout.
 */
export async function transcribe(
  wav: ArrayBuffer,
  settings: Pick<Settings, 'whisperBaseUrl' | 'whisperModel'>,
  apiKey: string,
  deps: WhisperDeps = { fetch },
  opts: WhisperOpts = {}
): Promise<string> {
  const retries = opts.retries ?? 2
  const timeoutMs = opts.timeoutMs ?? 20_000
  const delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const temperature = opts.temperature ?? 0
  const url = joinUrl(settings.whisperBaseUrl, 'audio/transcriptions')

  let prompt = opts.prompt || undefined
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await attemptTranscribe(url, wav, settings.whisperModel, apiKey, deps, timeoutMs, prompt, temperature)
    } catch (e) {
      lastError = e
      // 4xx is a real client error (bad key, bad request) — retrying won't help.
      // Exception: the optional bias prompt may be what the server rejects, so try
      // once more without it before giving up.
      if (e instanceof TranscriptionError && e.status && e.status >= 400 && e.status < 500) {
        if (prompt) {
          prompt = undefined
          attempt--
          continue
        }
        throw e
      }
      if (attempt < retries) await delay(250 * (attempt + 1))
    }
  }
  throw lastError
}

async function attemptTranscribe(
  url: string,
  wav: ArrayBuffer,
  model: string,
  apiKey: string,
  deps: WhisperDeps,
  timeoutMs: number,
  prompt?: string,
  temperature = 0
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', model)
  form.append('language', 'en')
  form.append('response_format', 'json')
  // Deterministic decoding — greedy, no sampling drift between identical dictations.
  form.append('temperature', String(temperature))
  if (prompt) form.append('prompt', prompt)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    })
  } catch (e) {
    throw new TranscriptionError(`Network error reaching Whisper: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new TranscriptionError(`Whisper returned ${res.status}: ${body.slice(0, 200)}`, res.status)
  }

  const data = (await res.json()) as { text?: string }
  return (data.text ?? '').trim()
}
