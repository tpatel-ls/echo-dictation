import { Tray, Menu, nativeImage } from 'electron'
import { join } from 'node:path'
import type { CleanupMode, Settings } from '@shared/types'
import { triggerLabel } from '@shared/trigger'
import type { SettingsStore } from './store/settings'

export interface TrayContext {
  openDashboard: () => void
  settings: SettingsStore
  onSettingsChanged: (s: Settings) => void
  quit: () => void
}

export function createTray(ctx: TrayContext): Tray {
  const img = nativeImage.createFromPath(join(__dirname, '../../build/tray.png'))
  const tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)

  const rebuild = (): void => {
    const s = ctx.settings.getSettings()
    tray.setToolTip(`Echo — hold ${triggerLabel(s.triggerKey)} to dictate`)
    const cleanupItems = (['off', 'on-demand', 'auto'] as CleanupMode[]).map((mode) => ({
      label: cleanupLabel(mode),
      type: 'radio' as const,
      checked: s.cleanupMode === mode,
      click: () => {
        ctx.onSettingsChanged(ctx.settings.setSettings({ cleanupMode: mode }))
        rebuild()
      }
    }))
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Echo', click: () => ctx.openDashboard() },
        { type: 'separator' },
        { label: 'AI cleanup', submenu: cleanupItems },
        { label: `Trigger: ${triggerLabel(s.triggerKey)}`, enabled: false },
        { type: 'separator' },
        { label: 'Quit Echo', click: () => ctx.quit() }
      ])
    )
  }

  rebuild()
  tray.on('click', () => ctx.openDashboard())
  return tray
}

function cleanupLabel(mode: CleanupMode): string {
  if (mode === 'off') return 'Off (raw Whisper)'
  if (mode === 'on-demand') return 'On-demand (polish in dashboard)'
  return 'Auto (clean every dictation)'
}
