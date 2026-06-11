import type { Settings } from '@shared/types'

/** Shape of the optional bootstrap file `secrets.local.json` (gitignored; bundled
 * into packaged builds). Keys seed encrypted secrets; URLs seed empty endpoints. */
export interface SeedFile {
  whisperApiKey?: string
  claudeApiKey?: string
  whisperBaseUrl?: string
  claudeBaseUrl?: string
}

/**
 * Fill endpoint settings that are still empty from the seed file — so a personal
 * build configured by one file works out of the box. Never overrides a URL the
 * user has set. Returns the patched settings, or null when nothing applied.
 */
export function applySeedEndpoints(settings: Settings, seed: SeedFile): Settings | null {
  const whisper = seed.whisperBaseUrl?.trim()
  const claude = seed.claudeBaseUrl?.trim()
  const patch: Partial<Settings> = {}
  if (!settings.whisperBaseUrl && whisper) patch.whisperBaseUrl = whisper
  if (!settings.claudeBaseUrl && claude) patch.claudeBaseUrl = claude
  if (!Object.keys(patch).length) return null
  return { ...settings, ...patch }
}
