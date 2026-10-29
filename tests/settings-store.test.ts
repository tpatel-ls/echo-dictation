import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const context = vi.hoisted(() => ({ packaged: true, appDir: '', userDir: '' }))
vi.mock('electron', () => ({ app: {
  get isPackaged() { return context.packaged },
  getPath: () => context.userDir,
  getAppPath: () => context.appDir
} }))
import { SettingsStore } from '../src/main/store/settings'
import { EMPTY_SECRETS } from '@shared/types'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'echo-seed-isolation-'))
  context.appDir = join(root, 'app')
  context.userDir = join(root, 'profile')
  context.packaged = true
  mkdirSync(context.appDir)
  writeFileSync(join(context.appDir, 'secrets.local.json'), JSON.stringify({
    whisperBaseUrl: 'https://obsolete.example/v1', whisperApiKey: 'obsolete-development-key'
  }))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('settings profile isolation', () => {
  it('never imports a stale development seed into an installed app profile', () => {
    const store = new SettingsStore()
    expect(store.getSecrets()).toEqual(EMPTY_SECRETS)
    expect(store.getSettings().whisperBaseUrl).toBe('')
  })
  it('keeps development setup seeds working for a source checkout', () => {
    context.packaged = false
    const store = new SettingsStore()
    expect(store.getSecrets().whisperApiKey).toBe('obsolete-development-key')
    expect(store.getSettings().whisperBaseUrl).toBe('https://obsolete.example/v1')
  })
  it('preserves the installed user’s own saved settings and credentials', () => {
    const store = new SettingsStore()
    store.setSecrets({ whisperApiKey: 'my-configured-key' })
    store.setSettings({ whisperBaseUrl: 'http://localhost:9876/v1' })
    const reopened = new SettingsStore()
    expect(reopened.getSecrets().whisperApiKey).toBe('my-configured-key')
    expect(reopened.getSettings().whisperBaseUrl).toBe('http://localhost:9876/v1')
  })
})
