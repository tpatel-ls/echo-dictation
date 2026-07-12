import { EMPTY_SECRETS, type Secrets } from '@shared/types'
import { writeFileAtomic } from './atomic-file'

export type AtomicSecretWriter = (
  path: string,
  data: string,
  options: { mode: number }
) => void

export function normalizeSecrets(input: unknown, defaults: Secrets = EMPTY_SECRETS): Secrets {
  const value = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
  return {
    whisperApiKey: typeof value.whisperApiKey === 'string'
      ? value.whisperApiKey
      : defaults.whisperApiKey,
    claudeApiKey: typeof value.claudeApiKey === 'string'
      ? value.claudeApiKey
      : defaults.claudeApiKey,
    syncToken: typeof value.syncToken === 'string' ? value.syncToken : defaults.syncToken
  }
}

export function persistSecretsFile(
  path: string,
  secrets: Secrets,
  writer: AtomicSecretWriter = writeFileAtomic
): void {
  writer(path, JSON.stringify(normalizeSecrets(secrets)), { mode: 0o600 })
}
