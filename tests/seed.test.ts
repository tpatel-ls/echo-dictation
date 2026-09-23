import { describe, it, expect } from 'vitest'
import { applySeedEndpoints, parseSeed, seedSecrets } from '../src/main/store/seed'
import { DEFAULT_SETTINGS, EMPTY_SECRETS, type Settings } from '@shared/types'

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

describe('seedSecrets', () => {
  it('seeds every key from the seed file, including the TypeSafe key', () => {
    expect(seedSecrets({
      whisperApiKey: 'w',
      claudeApiKey: 'c',
      syncToken: 's',
      typesafeApiKey: 't',
      calendarIcsUrl: 'https://calendar.example/private/basic.ics',
      whisperBaseUrl: 'https://w/v1'
    })).toEqual({
      whisperApiKey: 'w',
      claudeApiKey: 'c',
      syncToken: 's',
      typesafeApiKey: 't',
      calendarIcsUrl: 'https://calendar.example/private/basic.ics'
    })
  })

  it('leaves keys the seed does not carry empty', () => {
    expect(seedSecrets({ typesafeApiKey: 't' })).toEqual({ ...EMPTY_SECRETS, typesafeApiKey: 't' })
    expect(seedSecrets({})).toEqual(EMPTY_SECRETS)
  })

  it('ignores non-string seed values', () => {
    expect(seedSecrets(parseSeed('{"typesafeApiKey":42,"claudeApiKey":"c"}'))).toEqual({
      ...EMPTY_SECRETS,
      claudeApiKey: 'c'
    })
  })
})

describe('applySeedEndpoints', () => {
  it('ships the recovery adjudicator default model', () => {
    expect(DEFAULT_SETTINGS.accuracyModel).toBe('gpt-5.4-mini')
  })

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

  it('can leave syncBaseUrl empty when an existing user disabled sync', () => {
    const out = applySeedEndpoints(settings(), { syncBaseUrl: 'https://sync.example' }, { seedSync: false })
    expect(out).toBeNull()
  })

  it('never overrides a syncBaseUrl the user already set', () => {
    const s = settings({ syncBaseUrl: 'https://mine.sync' })
    const out = applySeedEndpoints(s, { syncBaseUrl: 'https://seed.sync' })
    expect(out).toBeNull()
  })

  it('never overrides an endpoint the user already set', () => {
    const s = settings({ whisperBaseUrl: 'https://mine.example/v1', accuracyModel: 'gpt-5.4' })
    const out = applySeedEndpoints(s, {
      whisperBaseUrl: 'https://seed.example/v1',
      claudeBaseUrl: 'https://c.example'
    })
    expect(out?.whisperBaseUrl).toBe('https://mine.example/v1')
    expect(out?.claudeBaseUrl).toBe('https://c.example')
    expect(out?.accuracyModel).toBe('gpt-5.4')
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
