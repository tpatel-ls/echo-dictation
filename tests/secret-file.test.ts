import { describe, expect, it, vi } from 'vitest'
import { EMPTY_SECRETS } from '@shared/types'
import {
  maskSecrets,
  normalizeSecrets,
  persistSecretsFile,
  type AtomicSecretWriter
} from '../src/main/store/secret-file'

describe('persistSecretsFile', () => {
  it('atomically writes only supported secret fields with owner-only permissions', () => {
    const writer: AtomicSecretWriter = vi.fn()

    persistSecretsFile('/users/me/secrets.bin', {
      whisperApiKey: 'whisper-key',
      claudeApiKey: 'claude-key',
      syncToken: 'sync-token',
      typesafeApiKey: 'typesafe-key',
      calendarIcsUrl: 'https://calendar.google.com/calendar/ical/me/private-abc/basic.ics'
    }, writer)

    expect(writer).toHaveBeenCalledWith(
      '/users/me/secrets.bin',
      JSON.stringify({
        whisperApiKey: 'whisper-key',
        claudeApiKey: 'claude-key',
        syncToken: 'sync-token',
        typesafeApiKey: 'typesafe-key',
        calendarIcsUrl: 'https://calendar.google.com/calendar/ical/me/private-abc/basic.ics'
      }),
      { mode: 0o600 }
    )
  })

  it('uses replacement semantics so callers can re-secure legacy files at startup', () => {
    const writer: AtomicSecretWriter = vi.fn()
    const secrets = { whisperApiKey: 'w', claudeApiKey: 'c', syncToken: 's', typesafeApiKey: 't', calendarIcsUrl: '' }
    persistSecretsFile('/legacy/secrets.bin', secrets, writer)
    expect(writer).toHaveBeenCalledOnce()
    expect(writer).toHaveBeenCalledWith('/legacy/secrets.bin', JSON.stringify(secrets), { mode: 0o600 })
  })
})

describe('normalizeSecrets', () => {
  it('drops unknown keys and replaces non-string values', () => {
    expect(normalizeSecrets({ whisperApiKey: 42, claudeApiKey: 'ok', extra: 'discard' })).toEqual({
      ...EMPTY_SECRETS,
      claudeApiKey: 'ok'
    })
  })

  it('keeps a saved TypeSafe key and falls back when it is not a string', () => {
    expect(normalizeSecrets({ typesafeApiKey: 'ts-key' }).typesafeApiKey).toBe('ts-key')
    expect(normalizeSecrets({ typesafeApiKey: 12 }, { ...EMPTY_SECRETS, typesafeApiKey: 'seeded' }).typesafeApiKey)
      .toBe('seeded')
  })

  it('reads files written before the TypeSafe key existed', () => {
    expect(normalizeSecrets({ whisperApiKey: 'w', claudeApiKey: 'c', syncToken: 's' })).toEqual({
      whisperApiKey: 'w',
      claudeApiKey: 'c',
      syncToken: 's',
      typesafeApiKey: '',
      calendarIcsUrl: ''
    })
  })

  it('keeps a saved calendar address', () => {
    expect(normalizeSecrets({ calendarIcsUrl: 'https://outlook.office365.com/owa/calendar/x/reachcalendar.ics' }).calendarIcsUrl)
      .toBe('https://outlook.office365.com/owa/calendar/x/reachcalendar.ics')
    expect(normalizeSecrets({ calendarIcsUrl: 3 }).calendarIcsUrl).toBe('')
  })

  it('returns empty secrets for invalid documents', () => {
    expect(normalizeSecrets(null)).toEqual(EMPTY_SECRETS)
    expect(normalizeSecrets(['nope'])).toEqual(EMPTY_SECRETS)
  })
})

describe('maskSecrets', () => {
  it('masks every secret, including the TypeSafe key, and leaves unset ones empty', () => {
    expect(maskSecrets({
      whisperApiKey: 'sk-whisper-0123456789',
      claudeApiKey: 'short',
      syncToken: '',
      typesafeApiKey: 'ts_live_abcdef987654',
      calendarIcsUrl: 'https://calendar.google.com/calendar/ical/me%40example.com/private-0123456789abcdef/basic.ics'
    })).toEqual({
      whisperApiKey: 'sk-whi…6789',
      claudeApiKey: '••••',
      syncToken: '',
      typesafeApiKey: 'ts_liv…7654',
      // Only the host: the path carries the secret.
      calendarIcsUrl: 'calendar.google.com/…'
    })
  })
})
