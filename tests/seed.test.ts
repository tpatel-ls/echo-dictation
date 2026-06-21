import { describe, it, expect } from 'vitest'
import { applySeedEndpoints, parseSeed } from '../src/main/store/seed'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides } // defaults ship with empty endpoint URLs
}

describe('parseSeed', () => {
  it('parses plain JSON', () => {
    expect(parseSeed('{"whisperBaseUrl":"https://w/v1"}')).toEqual({ whisperBaseUrl: 'https://w/v1' })
  })

  it('tolerates a UTF-8 BOM (Notepad / PowerShell write these)', () => {
    expect(parseSeed('\uFEFF' + '{"whisperBaseUrl":"https://w/v1"}')).toEqual({
      whisperBaseUrl: 'https://w/v1'
    })
  })

  it('returns empty seed for invalid JSON', () => {
    expect(parseSeed('not json')).toEqual({})
  })
})

describe('applySeedEndpoints', () => {
  it('fills an empty whisperBaseUrl from the seed', () => {
    const out = applySeedEndpoints(settings(), { whisperBaseUrl: 'https://w.example/v1' })
    expect(out?.whisperBaseUrl).toBe('https://w.example/v1')
  })

  it('fills an empty claudeBaseUrl from the seed', () => {
    const out = applySeedEndpoints(settings(), { claudeBaseUrl: 'https://c.example' })
    expect(out?.claudeBaseUrl).toBe('https://c.example')
  })

  it('fills an empty syncBaseUrl from the seed', () => {
    const out = applySeedEndpoints(settings(), { syncBaseUrl: 'https://sync.example' })
    expect(out?.syncBaseUrl).toBe('https://sync.example')
  })

  it('never overrides a syncBaseUrl the user already set', () => {
    const s = settings({ syncBaseUrl: 'https://mine.sync' })
    const out = applySeedEndpoints(s, { syncBaseUrl: 'https://seed.sync' })
    expect(out).toBeNull()
  })

  it('never overrides an endpoint the user already set', () => {
    const s = settings({ whisperBaseUrl: 'https://mine.example/v1' })
    const out = applySeedEndpoints(s, {
      whisperBaseUrl: 'https://seed.example/v1',
      claudeBaseUrl: 'https://c.example'
    })
    expect(out?.whisperBaseUrl).toBe('https://mine.example/v1')
    expect(out?.claudeBaseUrl).toBe('https://c.example')
  })

  it('returns null when the seed has no endpoints to offer', () => {
    expect(applySeedEndpoints(settings(), { whisperApiKey: 'sk-x' })).toBeNull()
    expect(applySeedEndpoints(settings(), {})).toBeNull()
  })

  it('returns null when settings are already complete', () => {
    const s = settings({ whisperBaseUrl: 'https://a/v1', claudeBaseUrl: 'https://b' })
    expect(applySeedEndpoints(s, { whisperBaseUrl: 'https://seed/v1' })).toBeNull()
  })

  it('trims seed values and ignores blank ones', () => {
    const out = applySeedEndpoints(settings(), { whisperBaseUrl: '  https://w.example/v1  ' })
    expect(out?.whisperBaseUrl).toBe('https://w.example/v1')
    expect(applySeedEndpoints(settings(), { whisperBaseUrl: '   ' })).toBeNull()
  })
})
