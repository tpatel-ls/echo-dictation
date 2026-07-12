import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import {
  DEFAULT_SETTINGS,
  EMPTY_SECRETS,
  type MaskedSecrets,
  type OSPlatform,
  type Secrets,
  type Settings
} from '@shared/types'
import { defaultTriggerKey } from '@shared/trigger'
import { writeFileAtomic } from './atomic-file'
import { applySeedEndpoints, parseSeed, type SeedFile } from './seed'

/**
 * Plain settings live as JSON in userData. API keys are stored separately in a local
 * JSON file for this personal Mac build. Avoid Electron safeStorage here: when Echo
 * starts hidden from launchd, Keychain can show an invisible prompt and block the
 * hotkey listener before it starts. A gitignored `secrets.local.json` (project root in
 * dev, bundled resources when packaged) seeds keys on first run and fills any endpoint
 * URLs the user hasn't set — one file makes a fresh install fully working.
 */
export class SettingsStore {
  private readonly settingsPath: string
  private readonly secretsPath: string
  private settings: Settings
  private secrets: Secrets

  constructor() {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    this.settingsPath = join(dir, 'settings.json')
    this.secretsPath = join(dir, 'secrets.bin')
    const hadSettings = existsSync(this.settingsPath)
    this.settings = this.loadSettings()
    this.secrets = this.loadSecrets()
    const seeded = applySeedEndpoints(this.settings, this.loadSeed(), { seedSync: !hadSettings })
    if (seeded) {
      this.settings = seeded
      this.persistSettings()
    }
  }

  getSettings(): Settings {
    return { ...this.settings }
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch }
    this.persistSettings()
    return this.getSettings()
  }

  getSecrets(): Secrets {
    return { ...this.secrets }
  }

  setSecrets(patch: Partial<Secrets>): void {
    this.secrets = { ...this.secrets, ...patch }
    this.persistSecrets(this.secrets)
  }

  getMaskedSecrets(): MaskedSecrets {
    return {
      whisperApiKey: mask(this.secrets.whisperApiKey),
      claudeApiKey: mask(this.secrets.claudeApiKey),
      syncToken: mask(this.secrets.syncToken)
    }
  }

  private loadSettings(): Settings {
    try {
      if (existsSync(this.settingsPath)) {
        const raw = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<Settings>
        return { ...DEFAULT_SETTINGS, ...raw }
      }
    } catch {
      /* fall through to defaults */
    }
    // Fresh install: the default trigger key depends on the keyboard. macOS has no
    // Right Ctrl, so a Windows default of RightControl would be undictatable there.
    return { ...DEFAULT_SETTINGS, triggerKey: defaultTriggerKey(process.platform as OSPlatform) }
  }

  private loadSecrets(): Secrets {
    const seed = this.loadSeed()
    try {
      if (existsSync(this.secretsPath)) {
        const raw = readFileSync(this.secretsPath, 'utf8').trim()
        if (raw.startsWith('{')) {
          return { ...EMPTY_SECRETS, ...seedSecrets(seed), ...(JSON.parse(raw) as Partial<Secrets>) }
        }
      }
    } catch {
      /* fall through to seed */
    }
    if (seed.whisperApiKey || seed.claudeApiKey || seed.syncToken) {
      const merged = seedSecrets(seed)
      this.persistSecrets(merged)
      return merged
    }
    return { ...EMPTY_SECRETS }
  }

  private loadSeed(): SeedFile {
    // dev: project root; packaged: bundled into resources via electron-builder.
    const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
    const candidates = [join(app.getAppPath(), 'secrets.local.json')]
    if (resourcesPath) candidates.push(join(resourcesPath, 'secrets.local.json'))
    for (const p of candidates) {
      try {
        if (existsSync(p)) {
          const seed = parseSeed(readFileSync(p, 'utf8'))
          if (Object.keys(seed).length) return seed
        }
      } catch {
        /* try next candidate */
      }
    }
    return {}
  }

  private persistSecrets(s: Secrets): void {
    const json = JSON.stringify(s)
    writeFileSync(this.secretsPath, json, { mode: 0o600 })
  }

  private persistSettings(): void {
    writeFileAtomic(this.settingsPath, JSON.stringify(this.settings, null, 2))
  }
}

function seedSecrets(seed: SeedFile): Secrets {
  return {
    whisperApiKey: seed.whisperApiKey ?? '',
    claudeApiKey: seed.claudeApiKey ?? '',
    syncToken: seed.syncToken ?? ''
  }
}

function mask(key: string): string {
  if (!key) return ''
  if (key.length <= 10) return '••••'
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}
