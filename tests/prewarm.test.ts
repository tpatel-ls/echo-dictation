import { describe, it, expect, vi } from 'vitest'
import { WhisperPrewarm, prewarmUrl } from '../src/main/transcription/prewarm'

const deps = (fetchMock: unknown) => ({ fetch: fetchMock as typeof fetch })

describe('prewarmUrl', () => {
  it('pings the server origin health endpoint, not the /v1 path', () => {
    expect(prewarmUrl('https://whisper.example/v1')).toBe('https://whisper.example/health')
    expect(prewarmUrl('https://whisper.example/v1/')).toBe('https://whisper.example/health')
    expect(prewarmUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/health')
  })

  it('returns null for an invalid URL', () => {
    expect(prewarmUrl('')).toBeNull()
    expect(prewarmUrl('not a url')).toBeNull()
  })
})

describe('WhisperPrewarm', () => {
  it('pings immediately on start and then on every interval while recording', () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response('ok'))
    const p = new WhisperPrewarm(deps(fetchMock))
    p.start('https://w.example/v1', 3000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(9000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    p.stop()
    vi.advanceTimersByTime(9000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    vi.useRealTimers()
  })

  it('swallows network errors — pre-warming must never break dictation', () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const p = new WhisperPrewarm(deps(fetchMock))
    expect(() => {
      p.start('https://w.example/v1', 3000)
      vi.advanceTimersByTime(3000)
      p.stop()
    }).not.toThrow()
    vi.useRealTimers()
  })

  it('does nothing for an empty base URL and restarts cleanly', () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response('ok'))
    const p = new WhisperPrewarm(deps(fetchMock))
    p.start('', 3000)
    vi.advanceTimersByTime(6000)
    expect(fetchMock).not.toHaveBeenCalled()
    p.start('https://w.example/v1', 3000)
    p.start('https://w.example/v1', 3000) // restart replaces the previous loop
    vi.advanceTimersByTime(3000)
    expect(fetchMock).toHaveBeenCalledTimes(3) // 2 immediate + 1 interval (single loop)
    p.stop()
    vi.useRealTimers()
  })
})
