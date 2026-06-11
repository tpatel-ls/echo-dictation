import type { Settings } from '@shared/types'

/** Shape of the optional bootstrap file `secrets.local.json` (gitignored; bundled
 * into packaged builds). Keys seed encrypted secrets; URLs seed empty endpoints. */
export interface SeedFile {
  whisperApiKey?: string
  claudeApiKey?: string
  whisperBaseUrl?: string
  claudeBaseUrl?: string
}

/** Parse a seed file's text, tolerating the UTF-8 BOM that Notepad and
 * PowerShell prepend — JSON.parse rejects it. Invalid JSON → empty seed. */
export function parseSeed(text: string): SeedFile {
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as SeedFile) : {}
  } catch {
    return {}
  }
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
