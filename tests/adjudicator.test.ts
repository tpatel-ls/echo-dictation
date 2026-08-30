import { describe, expect, it, vi } from 'vitest'
import { adjudicate } from '../src/main/transcription/adjudicator'
import type { TranscriptCandidate } from '@shared/transcript-quality'

const settings = {
  claudeBaseUrl: 'https://proxy.example/v1',
  accuracyModel: 'gpt-5.4-mini',
  claudeModel: 'claude-sonnet-4-6'
}
const deps = (mock: unknown): { fetch: typeof fetch } => ({ fetch: mock as typeof fetch })

const candidates: TranscriptCandidate[] = [
  { source: 'remote-primary', text: 'It is not working correctly.', elapsedMs: 180 },
  { source: 'native', text: 'It is not working correctly.', elapsedMs: 260 }
]

describe('adjudicate', () => {
  it('posts an OpenAI-compatible Responses request and returns clean output_text', async () => {
    const fetchMock = vi.fn(async (url: unknown, init: any) => {
      expect(url).toBe('https://proxy.example/v1/v1/responses')
      expect(init.method).toBe('POST')
      expect(init.headers.Authorization).toBe('Bearer KEY')
      expect(init.headers['content-type']).toBe('application/json')

      const body = JSON.parse(init.body)
      expect(body.store).toBe(false)
      expect(body.model).toBe('gpt-5.4-mini')
      expect(JSON.stringify(body.input)).toContain('Visual Studio Code')
      expect(JSON.stringify(body.input)).toContain('Candidate A')
      expect(JSON.stringify(body.input)).toContain('Candidate B')
      expect(JSON.stringify(body.input)).toContain('Glossary')
      expect(JSON.stringify(body.input)).toContain('phonetic')
      expect(JSON.stringify(body.input)).toContain('reconstruct')
      expect(JSON.stringify(body.input)).toContain('letter')

      return new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'It is not working correctly.' }] }]
        }),
        { status: 200 }
      )
    })

    expect(await adjudicate(candidates, 'Visual Studio Code', settings, 'KEY', deps(fetchMock))).toBe(
      'It is not working correctly.'
    )
  })

  it('returns the exact selected candidate when the model responds with only a letter', async () => {
    const distinctCandidates: TranscriptCandidate[] = [
      { source: 'remote-primary', text: 'Create the get hub issues.', elapsedMs: 180 },
      { source: 'remote-recovery', text: 'Create the GitHub issues.', elapsedMs: 220 },
      { source: 'remote-recovery', text: 'Create GitHub issue.', elapsedMs: 240 }
    ]
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'B' }] }]
        }),
        { status: 200 }
      )
    )

    await expect(adjudicate(distinctCandidates, 'Visual Studio Code', settings, 'KEY', deps(fetchMock))).resolves.toBe(
      'Create the GitHub issues.'
    )
  })

  it('passes glossary terms into the prompt and output quality gate', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body)
      expect(JSON.stringify(body.input)).toContain('Glossary: Þór')

      return new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Deploy Þór now.' }] }]
        }),
        { status: 200 }
      )
    })

    await expect(adjudicate(candidates, 'Terminal', settings, 'KEY', deps(fetchMock), ['Þór'])).resolves.toBe(
      'Deploy Þór now.'
    )
  })

  it('returns null for assistant-style or wrapped adjudicator output', async () => {
    const replyMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'Here is the transcript: It is not working correctly.' }] }
          ]
        }),
        { status: 200 }
      )
    )

    await expect(adjudicate(candidates, '', settings, 'KEY', deps(replyMock))).resolves.toBeNull()
  })

  it('ignores non-output_text content', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'refusal', text: 'nope' }] }]
        }),
        { status: 200 }
      )
    )

    await expect(adjudicate(candidates, 'Visual Studio Code', settings, 'KEY', deps(fetchMock))).resolves.toBeNull()
  })

  it('falls back to the configured Claude model when the primary adjudicator is cooling down', async () => {
    const models: string[] = []
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body)
      models.push(body.model)
      if (body.model === 'gpt-5.4-mini') {
        return new Response(JSON.stringify({ error: { message: 'model cooldown' } }), { status: 429 })
      }
      return new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'It is not working correctly.' }] }]
        }),
        { status: 200 }
      )
    })

    await expect(adjudicate(candidates, 'Visual Studio Code', settings, 'KEY', deps(fetchMock))).resolves.toBe(
      'It is not working correctly.'
    )
    expect(models).toEqual(['gpt-5.4-mini', 'claude-sonnet-4-6'])
  })

  it('bounds a stalled adjudicator request without trying a slower fallback model', async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init: any) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )

    await expect(
      adjudicate(candidates, 'Visual Studio Code', settings, 'KEY', {
        fetch: fetchMock as unknown as typeof fetch,
        timeoutMs: 5
      })
    ).rejects.toThrow(/timed out/i)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
