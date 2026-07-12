import { describe, expect, it, vi } from 'vitest'
import { EMPTY_SECRETS } from '@shared/types'
import { normalizeSecrets, persistSecretsFile, type AtomicSecretWriter } from '../src/main/store/secret-file'

describe('persistSecretsFile', () => {
  it('atomically writes only supported secret fields with owner-only permissions', () => {
    const writer: AtomicSecretWriter = vi.fn()

    persistSecretsFile('/users/me/secrets.bin', {
      whisperApiKey: 'whisper-key',
      claudeApiKey: 'claude-key',
      syncToken: 'sync-token'
    }, writer)

    expect(writer).toHaveBeenCalledWith(
      '/users/me/secrets.bin',
      JSON.stringify({
        whisperApiKey: 'whisper-key',
        claudeApiKey: 'claude-key',
        syncToken: 'sync-token'
      }),
      { mode: 0o600 }
    )
  })
})

describe('normalizeSecrets', () => {
  it('drops unknown keys and replaces non-string values', () => {
    expect(normalizeSecrets({ whisperApiKey: 42, claudeApiKey: 'ok', extra: 'discard' })).toEqual({
      ...EMPTY_SECRETS,
      claudeApiKey: 'ok'
    })
  })

  it('returns empty secrets for invalid documents', () => {
    expect(normalizeSecrets(null)).toEqual(EMPTY_SECRETS)
    expect(normalizeSecrets(['nope'])).toEqual(EMPTY_SECRETS)
  })
})
