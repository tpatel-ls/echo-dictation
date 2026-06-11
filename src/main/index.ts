import { app, BrowserWindow, session } from 'electron'
import { SettingsStore } from './store/settings'
import { openHistory } from './store/history-file'
import { createOverlay, createDashboard } from './windows'
import { DictationController } from './dictation'
import { HotkeyListener } from './hotkey/listener'
import { registerIpc } from './ipc'
import { createTray } from './tray'
import { IPC, type Settings } from '@shared/types'

// Keep the always-on app alive through stray errors — one unhandled exception must
// never take down the tray + global hotkey. Log and continue.
process.on('uncaughtException', (err) => console.error('[echo] uncaughtException:', err))
process.on('unhandledRejection', (reason) => console.error('[echo] unhandledRejection:', reason))

app.setAppUserModelId('com.tanay.echo')

// Test/verification isolation: redirect all storage (and the single-instance lock,
// which is keyed off userData) so automated runs never touch the real profile.
if (process.env.ECHO_USER_DATA) app.setPath('userData', process.env.ECHO_USER_DATA)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(main).catch((e) => {
    console.error('Echo failed to start:', e)
    app.quit()
  })
}

async function main(): Promise<void> {
  // Electron denies getUserMedia by default — grant microphone access so the
  // overlay can capture audio. (OS-level mic privacy must also be enabled.)
  const allowMic = (permission: string): boolean =>
    permission === 'media' || permission === 'audioCapture' || permission === 'mediaKeySystem'
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowMic(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMic(permission))

  const settings = new SettingsStore()
  const { store: history, dictionary, flush } = await openHistory()

  const openedHidden = process.argv.includes('--hidden')
  let quitting = false

  const overlay = createOverlay(settings.getSettings().overlayOffsetBottom)
  let dashboard: BrowserWindow | null = null

  const openDashboard = (): void => {
    if (dashboard && !dashboard.isDestroyed()) {
      dashboard.show()
      dashboard.focus()
      return
    }
    dashboard = createDashboard()
    dashboard.once('ready-to-show', () => dashboard?.show())
    // Close-to-tray: closing the window keeps Echo running in the background.
    dashboard.on('close', (e) => {
      if (!quitting) {
        e.preventDefault()
        dashboard?.hide()
      }
    })
  }

  // Auto-launch at login passes --hidden so we boot straight to the tray.
  if (!openedHidden) openDashboard()

  const controller = new DictationController(overlay, settings, history, dictionary)

  const opts = (): { minHoldMs: number; cancelOnOtherKey: boolean } => {
    const s = settings.getSettings()
    return { minHoldMs: s.minHoldMs, cancelOnOtherKey: s.cancelOnOtherKey }
  }

  const listener = new HotkeyListener(opts(), settings.getSettings().triggerKey, {
    onStart: () => void controller.onStart(),
    onStop: () => controller.onStop(),
    onCancel: () => controller.onCancel()
  })
  try {
    listener.start()
  } catch (e) {
    console.error('Global hotkey listener failed to start:', e)
  }

  const onSettingsChanged = (s: Settings): void => {
    listener.update({ minHoldMs: s.minHoldMs, cancelOnOtherKey: s.cancelOnOtherKey }, s.triggerKey)
    applyLoginItem(s.launchAtLogin)
    if (!overlay.isDestroyed()) overlay.webContents.send(IPC.SETTINGS_CHANGED, s)
    if (dashboard && !dashboard.isDestroyed()) dashboard.webContents.send(IPC.SETTINGS_CHANGED, s)
  }

  registerIpc({ settings, history, dictionary, controller, listener, openDashboard, onSettingsChanged })
  createTray({
    openDashboard,
    settings,
    onSettingsChanged,
    quit: () => {
      quitting = true
      flush()
      app.exit(0)
    }
  })

  applyLoginItem(settings.getSettings().launchAtLogin)

  app.on('second-instance', openDashboard)
  app.on('activate', openDashboard)
  app.on('window-all-closed', () => {
    /* tray app — keep running with no visible windows */
  })
  app.on('before-quit', () => {
    quitting = true
    try {
      listener.stop()
    } catch {
      /* ignore */
    }
    flush()
  })
}

/**
 * Register (or clear) auto-launch at login. Only the packaged app should auto-start —
 * in dev this would register the Electron binary, which is broken at boot, so we clear
 * any stale dev entry instead. The packaged app launches with --hidden (tray only).
 */
function applyLoginItem(enabled: boolean): void {
  if (!app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: false })
    return
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: ['--hidden']
  })
}
