import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import {
  DEFAULT_SETTINGS,
  EMPTY_SECRETS,
  type MaskedSecrets,
  type Secrets,
  type Settings
} from '@shared/types'
import { applySeedEndpoints, type SeedFile } from './seed'

/**
 * Plain settings live as JSON in userData. API keys are stored separately, encrypted
 * via Electron's safeStorage (OS keychain). A gitignored `secrets.local.json` (project
 * root in dev, bundled resources when packaged) seeds keys on first run and fills any
 * endpoint URLs the user hasn't set — one file makes a fresh install fully working.
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
    this.settings = this.loadSettings()
    this.secrets = this.loadSecrets()
    const seeded = applySeedEndpoints(this.settings, this.loadSeed())
    if (seeded) {
      this.settings = seeded
      writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2))
    }
  }

  getSettings(): Settings {
    return { ...this.settings }
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch }
    writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2))
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
      claudeApiKey: mask(this.secrets.claudeApiKey)
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
    return { ...DEFAULT_SETTINGS }
  }

  private loadSecrets(): Secrets {
    try {
      if (existsSync(this.secretsPath)) {
        const buf = readFileSync(this.secretsPath)
        const json = safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(buf)
          : buf.toString('utf8')
        return { ...EMPTY_SECRETS, ...(JSON.parse(json) as Partial<Secrets>) }
      }
    } catch {
      /* fall through to seed */
    }
    const seed = this.loadSeed()
    if (seed.whisperApiKey || seed.claudeApiKey) {
      const merged: Secrets = {
        whisperApiKey: seed.whisperApiKey ?? '',
        claudeApiKey: seed.claudeApiKey ?? ''
      }
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
        if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as SeedFile
      } catch {
        /* try next candidate */
      }
    }
    return {}
  }

  private persistSecrets(s: Secrets): void {
    const json = JSON.stringify(s)
    const buf = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, 'utf8')
    writeFileSync(this.secretsPath, buf)
  }
}

function mask(key: string): string {
  if (!key) return ''
  if (key.length <= 10) return '••••'
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}
