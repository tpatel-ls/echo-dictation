import { describe, it, expect, vi } from 'vitest'
import { diarize, transcribeSegments, SpeechRouteError } from '../src/main/meetings/speech-client'

const conn = { baseUrl: 'https://gb.example/whisper/v1/', apiKey: 'KEY' }
const wav = new ArrayBuffer(16)
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
const deps = (mock: unknown, extra: { timeoutMs?: number } = {}) => ({
  fetch: mock as typeof fetch,
  delay: async () => {}, // no real backoff waits in tests
  ...extra
})

const unit = (dim: number, hot: number): number[] => Array.from({ length: dim }, (_, i) => (i === hot ? 1 : 0))

const diarizationPayload = () => ({
  duration: 42.5,
  model: 'pyannote/speaker-diarization-community-1',
  embedding_model: 'pyannote/wespeaker-voxceleb-resnet34-LM',
  embedding_dim: 4,
  segments: [
    { start: 0.5, end: 7.25, speaker: 'SPEAKER_00' },
    { start: 7.5, end: 12, speaker: 'SPEAKER_01' },
    { start: 12.2, end: 20, speaker: 'SPEAKER_00' }
  ],
  speakers: [
    { id: 'SPEAKER_00', speech_seconds: 14.55, turns: 2, embedding: unit(4, 0) },
    { id: 'SPEAKER_01', speech_seconds: 4.5, turns: 1, embedding: unit(4, 1) }
  ]
})

describe('diarize', () => {
  it('posts the WAV and speaker hints to /audio/diarizations with the Bearer key', async () => {
    const fetchMock = vi.fn(async (url: unknown, init: any) => {
      expect(url).toBe('https://gb.example/whisper/v1/audio/diarizations')
      expect(init.method).toBe('POST')
      expect(init.headers.Authorization).toBe('Bearer KEY')
      const form = init.body as FormData
      expect(form).toBeInstanceOf(FormData)
      const file = form.get('file') as File
      expect(file.name).toBe('audio.wav')
      expect(file.type).toBe('audio/wav')
      expect(file.size).toBe(16)
      expect(form.get('max_speakers')).toBe('8')
      expect(form.get('min_speakers')).toBe('1')
      expect(form.get('num_speakers')).toBeNull()
      expect(form.get('embeddings')).toBe('true')
      return json(diarizationPayload())
    })
    await diarize(wav, { minSpeakers: 1, maxSpeakers: 8 }, conn, deps(fetchMock))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends num_speakers when the count is known', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      const form = init.body as FormData
      expect(form.get('num_speakers')).toBe('2')
      expect(form.get('min_speakers')).toBeNull()
      expect(form.get('max_speakers')).toBeNull()
      return json(diarizationPayload())
    })
    await diarize(wav, { numSpeakers: 2 }, conn, deps(fetchMock))
  })

  it('maps the snake_case response to the camelCase contract', async () => {
    const fetchMock = vi.fn(async () => json(diarizationPayload()))
    const out = await diarize(wav, {}, conn, deps(fetchMock))
    expect(out).toEqual({
      duration: 42.5,
      model: 'pyannote/speaker-diarization-community-1',
      embeddingModel: 'pyannote/wespeaker-voxceleb-resnet34-LM',
      embeddingDim: 4,
      segments: [
        { start: 0.5, end: 7.25, speaker: 'SPEAKER_00' },
        { start: 7.5, end: 12, speaker: 'SPEAKER_01' },
        { start: 12.2, end: 20, speaker: 'SPEAKER_00' }
      ],
      speakers: [
        { id: 'SPEAKER_00', speechSeconds: 14.55, turns: 2, embedding: [1, 0, 0, 0] },
        { id: 'SPEAKER_01', speechSeconds: 4.5, turns: 1, embedding: [0, 1, 0, 0] }
      ]
    })
  })

  it('returns turns sorted by start time', async () => {
    const payload = diarizationPayload()
    payload.segments.reverse()
    const out = await diarize(wav, {}, conn, deps(vi.fn(async () => json(payload))))
    expect(out.segments.map((s) => s.start)).toEqual([0.5, 7.5, 12.2])
  })

  it('accepts an empty diarization (no speech)', async () => {
    const payload = { ...diarizationPayload(), duration: 3, segments: [], speakers: [] }
    const out = await diarize(wav, {}, conn, deps(vi.fn(async () => json(payload))))
    expect(out.segments).toEqual([])
    expect(out.speakers).toEqual([])
  })

  it('turns null, missing, wrong-length, or non-finite embeddings into null', async () => {
    const payload = diarizationPayload() as any
    payload.speakers = [
      { id: 'A', speech_seconds: 2, turns: 1, embedding: null },
      { id: 'B', speech_seconds: 9, turns: 3 },
      { id: 'C', speech_seconds: 9, turns: 3, embedding: [1, 0, 0] },
      { id: 'D', speech_seconds: 9, turns: 3, embedding: [1, 0, null, 0] },
      { id: 'E', speech_seconds: 9, turns: 3, embedding: [1, 0, 'x', 0] },
      { id: 'F', speech_seconds: 9, turns: 3, embedding: 'nope' }
    ]
    payload.segments = []
    const out = await diarize(wav, {}, conn, deps(vi.fn(async () => json(payload))))
    expect(out.speakers.map((s) => s.embedding)).toEqual([null, null, null, null, null, null])
  })

  it.each([
    ['a non-object body', []],
    ['a missing duration', { ...diarizationPayload(), duration: undefined }],
    ['a non-finite duration', { ...diarizationPayload(), duration: 'long' }],
    ['a missing model', { ...diarizationPayload(), model: 7 }],
    ['a missing embedding_model', { ...diarizationPayload(), embedding_model: undefined }],
    ['a negative embedding_dim', { ...diarizationPayload(), embedding_dim: -1 }],
    ['segments that are not an array', { ...diarizationPayload(), segments: {} }],
    ['a turn that ends before it starts', { ...diarizationPayload(), segments: [{ start: 5, end: 4, speaker: 'SPEAKER_00' }] }],
    ['a turn with no speaker', { ...diarizationPayload(), segments: [{ start: 1, end: 4 }] }],
    ['a turn for an unknown speaker', { ...diarizationPayload(), segments: [{ start: 1, end: 4, speaker: 'SPEAKER_09' }] }],
    ['a speaker with no id', { ...diarizationPayload(), speakers: [{ speech_seconds: 1, turns: 1, embedding: null }] }],
    ['a speaker with non-finite speech_seconds', { ...diarizationPayload(), speakers: [{ id: 'SPEAKER_00', speech_seconds: null, turns: 1, embedding: null }] }],
    ['a speaker with fractional turns', { ...diarizationPayload(), speakers: [{ id: 'SPEAKER_00', speech_seconds: 1, turns: 1.5, embedding: null }] }]
  ])('rejects %s', async (_label, payload) => {
    const fetchMock = vi.fn(async () => json(payload))
    await expect(diarize(wav, {}, conn, deps(fetchMock))).rejects.toBeInstanceOf(SpeechRouteError)
    expect(fetchMock).toHaveBeenCalledTimes(1) // a malformed payload is not retried
  })

  it('rejects a body that is not JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 200 }))
    await expect(diarize(wav, {}, conn, deps(fetchMock))).rejects.toThrow(SpeechRouteError)
  })

  it('retries 5xx and network errors, then succeeds', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls === 1) return new Response('upstream down', { status: 502 })
      if (calls === 2) throw new Error('ECONNRESET')
      return json(diarizationPayload())
    })
    const delays: number[] = []
    const out = await diarize(wav, {}, conn, {
      fetch: fetchMock as unknown as typeof fetch,
      delay: async (ms) => {
        delays.push(ms)
      }
    })
    expect(out.speakers).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(delays).toHaveLength(2)
    expect(delays[1]).toBeGreaterThan(delays[0]) // backoff grows
  })

  it('gives up after two retries with the last 5xx status', async () => {
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }))
    const err = await diarize(wav, {}, conn, deps(fetchMock)).catch((e) => e)
    expect(err).toBeInstanceOf(SpeechRouteError)
    expect(err.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('never retries a 4xx', async () => {
    const fetchMock = vi.fn(async () =>
      json({ error: { message: 'Unauthorized', type: 'invalid_request_error', code: 401 } }, 401)
    )
    const err = await diarize(wav, {}, conn, deps(fetchMock)).catch((e) => e)
    expect(err).toBeInstanceOf(SpeechRouteError)
    expect(err.status).toBe(401)
    expect(err.message).toMatch(/Unauthorized/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborts a request that exceeds the timeout', async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init: any) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    )
    const err = await diarize(wav, {}, conn, deps(fetchMock, { timeoutMs: 20 })).catch((e) => e)
    expect(err).toBeInstanceOf(SpeechRouteError)
    expect(err.message).toMatch(/timed out/i)
    // A timed-out job would only time out again (and pile more work on the GPU): no retry.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('transcribeSegments', () => {
  const segments = [
    { id: 'a', start: 0, end: 4.25 },
    { id: 'b', start: 5, end: 9.5 },
    { id: 'c', start: 10, end: 12 }
  ]
  const models = ['canary-qwen-2.5b', 'parakeet-tdt-0.6b-v2']

  it('posts the WAV, the model list, and the segment JSON to /audio/segments', async () => {
    const fetchMock = vi.fn(async (url: unknown, init: any) => {
      expect(url).toBe('https://gb.example/whisper/v1/audio/segments')
      expect(init.method).toBe('POST')
      expect(init.headers.Authorization).toBe('Bearer KEY')
      const form = init.body as FormData
      const file = form.get('file') as File
      expect(file.name).toBe('audio.wav')
      expect(file.type).toBe('audio/wav')
      expect(form.get('models')).toBe('canary-qwen-2.5b,parakeet-tdt-0.6b-v2')
      expect(JSON.parse(form.get('segments') as string)).toEqual(segments)
      return json({ results: segments.map((s) => ({ id: s.id, texts: { 'canary-qwen-2.5b': s.id.toUpperCase() } })) })
    })
    await transcribeSegments(wav, segments, models, conn, deps(fetchMock))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends the keyword prompt when there is one, and no prompt field otherwise', async () => {
    const prompts: unknown[] = []
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      prompts.push((init.body as FormData).get('prompt'))
      return json({ results: [] })
    })
    await transcribeSegments(wav, segments, models, conn, deps(fetchMock), 'Zeltra, BROXA, hiring@NWG')
    await transcribeSegments(wav, segments, models, conn, deps(fetchMock), '')
    await transcribeSegments(wav, segments, models, conn, deps(fetchMock))
    expect(prompts).toEqual(['Zeltra, BROXA, hiring@NWG', null, null])
  })

  it('returns results in request order, with empty texts for ids the server omitted', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        results: [
          { id: 'c', texts: { 'canary-qwen-2.5b': 'Third.', 'parakeet-tdt-0.6b-v2': 'Third' } },
          { id: 'a', texts: { 'parakeet-tdt-0.6b-v2': 'First' } },
          { id: 'zzz', texts: { 'canary-qwen-2.5b': 'not asked for' } }
        ]
      })
    )
    const out = await transcribeSegments(wav, segments, models, conn, deps(fetchMock))
    expect(out).toEqual([
      { id: 'a', texts: { 'parakeet-tdt-0.6b-v2': 'First' } },
      { id: 'b', texts: {} },
      { id: 'c', texts: { 'canary-qwen-2.5b': 'Third.', 'parakeet-tdt-0.6b-v2': 'Third' } }
    ])
  })

  it('does not call the server for an empty segment list', async () => {
    const fetchMock = vi.fn()
    expect(await transcribeSegments(wav, [], models, conn, deps(fetchMock))).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['no results array', { text: 'hello' }],
    ['a result with no id', { results: [{ texts: {} }] }],
    ['a result with no texts', { results: [{ id: 'a' }] }],
    ['texts that are an array', { results: [{ id: 'a', texts: ['x'] }] }],
    ['a non-string text', { results: [{ id: 'a', texts: { 'canary-qwen-2.5b': 3 } }] }]
  ])('rejects %s', async (_label, payload) => {
    const fetchMock = vi.fn(async () => json(payload))
    await expect(transcribeSegments(wav, segments, models, conn, deps(fetchMock))).rejects.toBeInstanceOf(
      SpeechRouteError
    )
  })

  it('surfaces a 400 validation error without retrying', async () => {
    const fetchMock = vi.fn(async () =>
      json({ error: { message: 'segment b is longer than 40 s', type: 'invalid_request_error' } }, 400)
    )
    const err = await transcribeSegments(wav, segments, models, conn, deps(fetchMock)).catch((e) => e)
    expect(err).toBeInstanceOf(SpeechRouteError)
    expect(err.status).toBe(400)
    expect(err.message).toMatch(/longer than 40 s/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a 500 then returns the result', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () =>
      ++calls === 1 ? new Response('boom', { status: 500 }) : json({ results: [{ id: 'a', texts: { m: 'hi' } }] })
    )
    const out = await transcribeSegments(wav, segments, ['m'], conn, deps(fetchMock))
    expect(out[0]).toEqual({ id: 'a', texts: { m: 'hi' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('aborts after the timeout', async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init: any) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    )
    const err = await transcribeSegments(wav, segments, models, conn, deps(fetchMock, { timeoutMs: 20 })).catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(SpeechRouteError)
    expect(err.message).toMatch(/timed out/i)
  })
})
