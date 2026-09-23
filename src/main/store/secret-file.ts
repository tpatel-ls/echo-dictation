import { EMPTY_SECRETS, type MaskedSecrets, type Secrets } from '@shared/types'
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
    syncToken: typeof value.syncToken === 'string' ? value.syncToken : defaults.syncToken,
    typesafeApiKey: typeof value.typesafeApiKey === 'string'
      ? value.typesafeApiKey
      : defaults.typesafeApiKey,
    calendarIcsUrl: typeof value.calendarIcsUrl === 'string'
      ? value.calendarIcsUrl
      : defaults.calendarIcsUrl
  }
}

export function persistSecretsFile(
  path: string,
  secrets: Secrets,
  writer: AtomicSecretWriter = writeFileAtomic
): void {
  writer(path, JSON.stringify(normalizeSecrets(secrets)), { mode: 0o600 })
}

/** What the renderer may see of each secret: enough to recognise it, never the key itself. */
export function maskSecrets(secrets: Secrets): MaskedSecrets {
  return {
    whisperApiKey: mask(secrets.whisperApiKey),
    claudeApiKey: mask(secrets.claudeApiKey),
    syncToken: mask(secrets.syncToken),
    typesafeApiKey: mask(secrets.typesafeApiKey),
    calendarIcsUrl: maskUrl(secrets.calendarIcsUrl)
  }
}

/** A secret address shows only its host; the path is the secret. */
function maskUrl(url: string): string {
  if (!url) return ''
  try {
    return `${new URL(url).host}/…`
  } catch {
    return mask(url)
  }
}

function mask(key: string): string {
  if (!key) return ''
  if (key.length <= 10) return '••••'
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}
