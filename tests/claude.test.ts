import { describe, it, expect, vi } from 'vitest'
import {
  cleanup,
  command,
  stripEmDashes,
  stripWrapper,
  protectBreaks,
  restoreBreaks,
  CleanupError,
  AUTO_CLEANUP_TIMEOUT_MS
} from '../src/main/transcription/claude'

describe('protectBreaks / restoreBreaks', () => {
  it('round-trips speaker-placed breaks through sentinel markers', () => {
    const text = 'Hi everyone\n\nThe next steps are done.\nThanks'
    const protectedText = protectBreaks(text)
    expect(protectedText).not.toContain('\n')
    expect(restoreBreaks(protectedText)).toBe(text)
  })

  it('restores markers regardless of surrounding whitespace the model adds', () => {
    expect(restoreBreaks('a ⟦PARA⟧b')).toBe('a\n\nb')
    expect(restoreBreaks('a⟦LINE⟧ b')).toBe('a\nb')
  })

  it('leaves break-free text untouched', () => {
    expect(protectBreaks('one line only')).toBe('one line only')
    expect(restoreBreaks('one line only')).toBe('one line only')
  })
})

describe('stripWrapper', () => {
  it('drops a leading "Here is the cleaned transcript:" line', () => {
    expect(stripWrapper('Here is the cleaned transcript:\n\nThe next steps are done.')).toBe(
      'The next steps are done.'
    )
    expect(stripWrapper("Here's the cleaned text:\nHello.")).toBe('Hello.')
  })

  it('drops leading and trailing --- separator lines', () => {
    expect(stripWrapper('---\nThe next steps are done.\n---')).toBe('The next steps are done.')
    expect(stripWrapper('Here is the cleaned transcript:\n\n---\n\nReady to test.')).toBe('Ready to test.')
  })

  it('drops separator lines BETWEEN paragraphs, leaving one blank line', () => {
    expect(stripWrapper('Hi everyone.\n\n---\n\nThe next steps are done.\n\n---\n\nWe are ready to test it.')).toBe(
      'Hi everyone.\n\nThe next steps are done.\n\nWe are ready to test it.'
    )
    expect(stripWrapper('First.\n***\nSecond.\n___\nThird.')).toBe('First.\n\nSecond.\n\nThird.')
  })

  it('does not touch dashes inside a sentence', () => {
    expect(stripWrapper('The range is 5-10 items - roughly.')).toBe('The range is 5-10 items - roughly.')
  })

  it('drops an invented leading Subject: line', () => {
    expect(stripWrapper('Subject: Last Quarter Numbers\n\nHi Bryan,\n\nThe numbers look good.')).toBe(
      'Hi Bryan,\n\nThe numbers look good.'
    )
    expect(stripWrapper('The subject: pricing came up again.')).toBe('The subject: pricing came up again.')
  })

  it('keeps real content that merely starts with "Here is"', () => {
    expect(stripWrapper('Here is the plan: we ship on Friday.')).toBe('Here is the plan: we ship on Friday.')
    expect(stripWrapper('Here is what I found in the logs.')).toBe('Here is what I found in the logs.')
  })

  it('leaves normal text untouched', () => {
    expect(stripWrapper('Hi everyone,\n\nThe next steps are done.')).toBe('Hi everyone,\n\nThe next steps are done.')
  })
})

describe('stripEmDashes', () => {
  it('replaces spaced and unspaced em dashes with commas', () => {
    expect(stripEmDashes('The report — which Bryan sent — is ready.')).toBe(
      'The report, which Bryan sent, is ready.'
    )
    expect(stripEmDashes('Revenue is up—nice work.')).toBe('Revenue is up, nice work.')
  })

  it('collapses an em dash that follows punctuation instead of doubling it', () => {
    expect(stripEmDashes('Ready, — thanks')).toBe('Ready, thanks')
    expect(stripEmDashes('Done: — next steps below')).toBe('Done: next steps below')
  })

  it('turns a line-leading em dash into a plain hyphen bullet', () => {
    expect(stripEmDashes('— first item\n— second item')).toBe('- first item\n- second item')
  })

  it('leaves text without em dashes untouched', () => {
    expect(stripEmDashes('Plain text, with commas - and a hyphen.')).toBe(
      'Plain text, with commas - and a hyphen.'
    )
  })
})

const s = {
  claudeBaseUrl: 'https://mac.ts.net',
  claudeModel: 'claude-sonnet-4-6',
  accuracyModel: 'gpt-5.4-mini'
}

function responsesText(text: string): Response {
  return new Response(
    JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }),
    { status: 200 }
  )
}

function cleanupSystem(body: any): string {
  return body.input[0].content[0].text as string
}

describe('cleanup', () => {
  it('uses the fast Responses model and parses text content', async () => {
    const fetchMock = vi.fn(async (url: unknown, init: any) => {
      expect(url).toBe('https://mac.ts.net/v1/responses')
      expect(init.headers.Authorization).toBe('Bearer KEY')
      const body = JSON.parse(init.body)
      expect(body.model).toBe('gpt-5.4-mini')
      expect(body.store).toBe(false)
      expect(body.input[1].content[0].text).toContain('<raw_transcript>')
      expect(body.input[1].content[0].text).toContain('um hello, uh, world')
      return responsesText('Hello, world.')
    })
    const out = await cleanup('um hello, uh, world', s, 'KEY', {
      fetch: fetchMock as unknown as typeof fetch
    })
    expect(out).toBe('Hello, world.')
  })

  it('falls back to input when the model returns no text', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ output: [] }), { status: 200 }))
    const out = await cleanup('keep me', s, 'KEY', { fetch: fetchMock as unknown as typeof fetch })
    expect(out).toBe('keep me')
  })

  it('falls back to the raw transcript when cleanup returns an assistant reply', async () => {
    const fetchMock = vi.fn(
      async () =>
        responsesText("You're welcome! Let me know if you need help with anything.")
    )
    const out = await cleanup('Thank you.', s, 'KEY', { fetch: fetchMock as unknown as typeof fetch })
    expect(out).toBe('Thank you.')
  })

  it('includes the dictionary glossary in the system prompt when provided', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body)
      expect(cleanupSystem(body)).toContain('Bryan, Tanay')
      return responsesText('x')
    })
    await cleanup('x', s, 'KEY', { fetch: fetchMock as unknown as typeof fetch }, ['Bryan', 'Tanay'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the base system prompt unchanged without a glossary', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body)
      expect(cleanupSystem(body)).not.toMatch(/vocabulary/i)
      return responsesText('x')
    })
    await cleanup('x', s, 'KEY', { fetch: fetchMock as unknown as typeof fetch })
  })

  it('instructs the model to organize paragraphs, obey spoken commands, and format emails', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      const system = cleanupSystem(JSON.parse(init.body))
      expect(system).toMatch(/paragraph/i)
      expect(system).toMatch(/spoken (formatting )?instruction/i)
      expect(system).toMatch(/full stop/i)
      expect(system).toMatch(/question mark/i)
      expect(system).toMatch(/standard American English/i)
      expect(system).toMatch(/possessive/i)
      expect(system).toMatch(/topic shift/i)
      expect(system).toMatch(/actually.*final correction/i)
      expect(system).toMatch(/email/i)
      expect(system).toMatch(/do not summarize|never summarize/i)
      expect(system).toMatch(/do not paraphrase/i)
      expect(system).toMatch(/never use em dashes/i)
      return responsesText('x')
    })
    await cleanup('x', s, 'KEY', { fetch: fetchMock as unknown as typeof fetch })
  })

  it('scrubs em dashes out of the model output as a hard guarantee', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'Numbers look good — see attached.' }] }),
          { status: 200 }
        )
    )
    const out = await cleanup('numbers look good see attached', s, 'KEY', {
      fetch: fetchMock as unknown as typeof fetch
    })
    expect(out).toBe('Numbers look good, see attached.')
  })

  it('throws CleanupError on non-200', async () => {
    const fetchMock = vi.fn(async () => new Response('bad', { status: 502 }))
    await expect(cleanup('x', s, 'KEY', { fetch: fetchMock as unknown as typeof fetch })).rejects.toBeInstanceOf(
      CleanupError
    )
  })

  it('bounds a stalled cleanup request', async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, init: RequestInit | undefined) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
    )

    await expect(
      cleanup('keep this text', s, 'KEY', {
        fetch: fetchMock as unknown as typeof fetch,
        timeoutMs: 5
      })
    ).rejects.toThrow(/timed out/i)
  })

  it('keeps automatic cleanup under a 3.5 second default ceiling', async () => {
    expect(AUTO_CLEANUP_TIMEOUT_MS).toBe(3500)
  })

  it('appends the style directive to the system prompt when provided', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      expect(cleanupSystem(JSON.parse(init.body))).toContain('professional')
      return responsesText('x')
    })
    await cleanup('x', s, 'KEY', { fetch: fetchMock as unknown as typeof fetch }, [], 'Format as professional writing.')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('command', () => {
  it('sends the instruction plus the text and parses the rewrite', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body)
      expect(body.system).toMatch(/editor/i)
      expect(body.messages[0].content).toContain('make it formal')
      expect(body.messages[0].content).toContain('hey whats up')
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hello, how are you?' }] }), { status: 200 })
    })
    const out = await command('hey whats up', 'make it formal', s, 'KEY', { fetch: fetchMock as unknown as typeof fetch })
    expect(out).toBe('Hello, how are you?')
  })

  it('falls back to the original text on an empty response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [] }), { status: 200 }))
    expect(await command('keep me', 'do nothing', s, 'KEY', { fetch: fetchMock as unknown as typeof fetch })).toBe('keep me')
  })
})
