import { describe, it, expect, vi } from 'vitest'
import { transcribe, joinUrl, TranscriptionError } from '../src/main/transcription/whisper'

const settings = { whisperBaseUrl: 'https://w.example/v1', whisperModel: 'whisper-1' }
const deps = (mock: unknown): { fetch: typeof fetch } => ({ fetch: mock as typeof fetch })
const fast = { delay: async () => {} } // no real backoff waits in tests

describe('joinUrl', () => {
  it('joins without double slashes', () => {
    expect(joinUrl('https://w/v1/', '/audio/transcriptions')).toBe('https://w/v1/audio/transcriptions')
    expect(joinUrl('https://w/v1', 'audio/transcriptions')).toBe('https://w/v1/audio/transcriptions')
  })
})

describe('transcribe', () => {
  it('posts multipart form and returns trimmed text', async () => {
    const fetchMock = vi.fn(async (url: unknown, init: any) => {
      expect(url).toBe('https://w.example/v1/audio/transcriptions')
      expect(init.method).toBe('POST')
      expect(init.headers.Authorization).toBe('Bearer KEY')
      expect(init.body).toBeInstanceOf(FormData)
      expect((init.body as FormData).get('model')).toBe('whisper-1')
      expect((init.body as FormData).get('language')).toBe('en')
      expect((init.body as FormData).get('temperature')).toBe('0')
      return new Response(JSON.stringify({ text: '  hello world  ' }), { status: 200 })
    })
    expect(await transcribe(new ArrayBuffer(8), settings, 'KEY', deps(fetchMock), fast)).toBe('hello world')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries transient network failures, then succeeds', async () => {
    let n = 0
    const fetchMock = vi.fn(async () => {
      n++
      if (n === 1) throw new Error('ECONNRESET')
      return new Response(JSON.stringify({ text: 'recovered' }), { status: 200 })
    })
    expect(await transcribe(new ArrayBuffer(8), settings, 'KEY', deps(fetchMock), fast)).toBe('recovered')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries on 5xx and gives up after retries', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 503 }))
    await expect(
      transcribe(new ArrayBuffer(8), settings, 'KEY', deps(fetchMock), { delay: async () => {}, retries: 2 })
    ).rejects.toBeInstanceOf(TranscriptionError)
    expect(fetchMock).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('does NOT retry a 4xx client error', async () => {
    const fetchMock = vi.fn(async () => new Response('bad key', { status: 401 }))
    await expect(
      transcribe(new ArrayBuffer(8), settings, 'KEY', deps(fetchMock), fast)
    ).rejects.toBeInstanceOf(TranscriptionError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('includes the bias prompt in the form when provided', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      expect((init.body as FormData).get('prompt')).toBe('Bryan, Tanay')
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 })
    })
    await transcribe(new ArrayBuffer(8), settings, 'KEY', deps(fetchMock), {
      delay: async () => {},
      prompt: 'Bryan, Tanay'
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('omits the prompt field when not provided', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      expect((init.body as FormData).get('prompt')).toBeNull()
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 })
    })
    await transcribe(new ArrayBuffer(8), settings, 'KEY', deps(fetchMock), fast)
  })

  it('retries without the prompt if the server rejects it with 4xx', async () => {
    const prompts: Array<string | null> = []
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      const p = (init.body as FormData).get('prompt') as string | null
      prompts.push(p)
      if (p !== null) return new Response('unknown field: prompt', { status: 400 })
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 })
    })
    const out = await transcribe(new ArrayBuffer(8), settings, 'KEY', deps(fetchMock), {
      delay: async () => {},
      prompt: 'Bryan'
    })
    expect(out).toBe('ok')
    expect(prompts).toEqual(['Bryan', null])
  })

  it('wraps network errors as TranscriptionError', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      transcribe(new ArrayBuffer(8), settings, 'KEY', deps(fetchMock), { delay: async () => {}, retries: 0 })
    ).rejects.toThrow(/Network error/)
  })
})
