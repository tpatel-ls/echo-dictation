import { describe, it, expect, vi } from 'vitest'
import { cleanup, CleanupError } from '../src/main/transcription/claude'

const s = { claudeBaseUrl: 'https://mac.ts.net', claudeModel: 'claude-sonnet-4-6' }

describe('cleanup', () => {
  it('posts the Anthropic messages shape and parses text content', async () => {
    const fetchMock = vi.fn(async (url: unknown, init: any) => {
      expect(url).toBe('https://mac.ts.net/v1/messages')
      expect(init.headers['x-api-key']).toBe('KEY')
      expect(init.headers['anthropic-version']).toBe('2023-06-01')
      const body = JSON.parse(init.body)
      expect(body.model).toBe('claude-sonnet-4-6')
      expect(body.messages[0].content).toBe('um hello, uh, world')
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'Hello, world.' }] }),
        { status: 200 }
      )
    })
    const out = await cleanup('um hello, uh, world', s, 'KEY', {
      fetch: fetchMock as unknown as typeof fetch
    })
    expect(out).toBe('Hello, world.')
  })

  it('falls back to input when the model returns no text', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [] }), { status: 200 }))
    const out = await cleanup('keep me', s, 'KEY', { fetch: fetchMock as unknown as typeof fetch })
    expect(out).toBe('keep me')
  })

  it('includes the dictionary glossary in the system prompt when provided', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body)
      expect(body.system).toContain('Bryan, Tanay')
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'x' }] }), { status: 200 })
    })
    await cleanup('x', s, 'KEY', { fetch: fetchMock as unknown as typeof fetch }, ['Bryan', 'Tanay'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the base system prompt unchanged without a glossary', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body)
      expect(body.system).not.toMatch(/vocabulary/i)
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'x' }] }), { status: 200 })
    })
    await cleanup('x', s, 'KEY', { fetch: fetchMock as unknown as typeof fetch })
  })

  it('throws CleanupError on non-200', async () => {
    const fetchMock = vi.fn(async () => new Response('bad', { status: 502 }))
    await expect(cleanup('x', s, 'KEY', { fetch: fetchMock as unknown as typeof fetch })).rejects.toBeInstanceOf(
      CleanupError
    )
  })
})
