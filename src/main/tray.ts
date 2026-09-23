import { Tray, Menu, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { CleanupMode, Settings } from '@shared/types'
import { MEETING_APP_LABELS, type LiveMeetingState } from '@shared/meeting-types'
import { triggerLabel } from '@shared/trigger'
import type { SettingsStore } from './store/settings'

export interface TrayMeetingContext {
  /** The current recording (drives the extra items and the tooltip). */
  live: () => LiveMeetingState
  stop: () => void
  discard: () => void
  setMicPaused: (paused: boolean) => void
}

export interface TrayContext {
  openDashboard: () => void
  settings: SettingsStore
  onSettingsChanged: (s: Settings) => void
  quit: () => void
  meeting?: TrayMeetingContext
}

export interface TrayHandle {
  tray: Tray
  /** Rebuild the menu and tooltip (e.g. when a meeting recording starts or ends). */
  refresh: () => void
}

export function createTray(ctx: TrayContext): TrayHandle {
  const img = nativeImage.createFromPath(join(__dirname, '../../build/tray.png'))
  const tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)

  const rebuild = (): void => {
    const s = ctx.settings.getSettings()
    const live = ctx.meeting?.live()
    // While a meeting is recorded the tray says so: Echo's own indicators are the only cue,
    // because process loopback has no Windows privacy indicator.
    const app = live?.phase === 'recording' && live.app ? MEETING_APP_LABELS[live.app] : null
    const detected = live?.phase === 'detected' && live.app ? MEETING_APP_LABELS[live.app] : null
    tray.setToolTip(
      app
        ? `Echo — transcribing ${app}`
        : detected
          ? `Echo — meeting detected (${detected}), starts when the call begins`
          : `Echo — hold ${triggerLabel(s.triggerKey)} to dictate`
    )
    const cleanupItems = (['off', 'on-demand', 'auto'] as CleanupMode[]).map((mode) => ({
      label: cleanupLabel(mode),
      type: 'radio' as const,
      checked: s.cleanupMode === mode,
      click: () => {
        ctx.onSettingsChanged(ctx.settings.setSettings({ cleanupMode: mode }))
        rebuild()
      }
    }))
    const meetingItems: MenuItemConstructorOptions[] =
      app && ctx.meeting
        ? [
            { label: `Transcribing ${app}`, enabled: false },
            {
              label: 'Pause my microphone',
              type: 'checkbox',
              checked: live?.micPaused ?? false,
              click: () => ctx.meeting?.setMicPaused(!(live?.micPaused ?? false))
            },
            { label: 'Stop meeting transcription', click: () => ctx.meeting?.stop() },
            { label: 'Discard meeting recording', click: () => ctx.meeting?.discard() },
            { type: 'separator' }
          ]
        : []
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...meetingItems,
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
  return { tray, refresh: rebuild }
}

function cleanupLabel(mode: CleanupMode): string {
  if (mode === 'off') return 'Off (raw Whisper)'
  if (mode === 'on-demand') return 'On-demand (polish in dashboard)'
  return 'Auto (clean every dictation)'
}
