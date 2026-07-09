import { app, BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { SettingsStore } from './store/settings'
import { openHistory } from './store/history-file'
import { SyncTable, SYNC_COLUMNS } from './sync/sync-table'
import { SyncClient, type SyncBinding } from './sync/client'
import { FileSyncState } from './sync/state'
import { SyncRunner } from './sync/runner'
import { createOverlay, createDashboard } from './windows'
import { DictationController } from './dictation'
import { HotkeyListener } from './hotkey/listener'
import { registerIpc } from './ipc'
import { createTray } from './tray'
import { showMacOnboardingIfNeeded } from './permissions'
import { IPC, type Settings } from '@shared/types'

// Keep the always-on app alive through stray errors — one unhandled exception must
// never take down the tray + global hotkey. Log and continue.
process.on('uncaughtException', (err) => console.error('[echo] uncaughtException:', err))
process.on('unhandledRejection', (reason) => console.error('[echo] unhandledRejection:', reason))

// How often the desktop reconciles with the sync service, on top of the change- and
// launch-triggered passes. Within the 30–60s target from the design spec.
const SYNC_INTERVAL_MS = 45_000
const smokeTest = process.env.ECHO_SMOKE_TEST === '1'

app.setAppUserModelId('com.tanay.echo')

// Test/verification isolation: redirect all storage (and the single-instance lock,
// which is keyed off userData) so automated runs never touch the real profile.
if (process.env.ECHO_USER_DATA) app.setPath('userData', process.env.ECHO_USER_DATA)

if (!smokeTest && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(main).catch((e) => {
    console.error('Echo failed to start:', e)
    app.quit()
  })
}

async function main(): Promise<void> {
  if (smokeTest) {
    app.exit(0)
    return
  }
  // Electron denies getUserMedia by default — grant microphone access so the
  // overlay can capture audio. (OS-level mic privacy must also be enabled.)
  const allowMic = (permission: string): boolean =>
    permission === 'media' || permission === 'audioCapture' || permission === 'mediaKeySystem'
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowMic(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMic(permission))

  const settings = new SettingsStore()

  // Sync: a store mutation nudges the runner, but the runner is built after the DB opens,
  // so the change hook forwards through a mutable indirection set just below.
  let nudgeSync = (): void => {}
  const { db, store: history, dictionary, snippets, flush, persist } = await openHistory({
    onChange: () => nudgeSync()
  })
  const syncBindings: SyncBinding[] = [
    { name: 'transcripts', table: new SyncTable(db, 'transcripts', [...SYNC_COLUMNS.transcripts]) },
    { name: 'dictionary', table: new SyncTable(db, 'dictionary', [...SYNC_COLUMNS.dictionary]) },
    { name: 'snippets', table: new SyncTable(db, 'snippets', [...SYNC_COLUMNS.snippets]) }
  ]
  const syncState = new FileSyncState(join(app.getPath('userData'), 'sync-state.json'))
  // The run closure reads settings/secrets fresh each pass: editing them in Settings takes
  // effect live, and an install without a sync endpoint simply no-ops.
  const syncRunner = new SyncRunner(async () => {
    const s = settings.getSettings()
    const sec = settings.getSecrets()
    if (!s.syncBaseUrl || !sec.syncToken) return // sync not configured yet
    const client = new SyncClient(syncBindings, { baseUrl: s.syncBaseUrl, token: sec.syncToken }, syncState)
    try {
      await client.syncOnce()
    } finally {
      // `applyRemote` writes pulled rows straight to the db and the pull cursor has already
      // advanced durably — so persist even if the push half then throws. Otherwise a crash
      // could strand those rows: the cursor moved past them but they never reached disk.
      persist()
    }
  })
  nudgeSync = (): void => syncRunner.trigger()
  syncRunner.trigger() // reconcile once on launch
  syncRunner.startInterval(SYNC_INTERVAL_MS) // periodic catch-up

  const openedHidden = process.argv.includes('--hidden')
  let quitting = false
  let onboardingShown = false

  const overlay = createOverlay(settings.getSettings().overlayOffsetBottom)
  let dashboard: BrowserWindow | null = null

  const maybeShowOnboarding = (): void => {
    if (onboardingShown) return
    onboardingShown = true
    void showMacOnboardingIfNeeded()
  }

  const openDashboard = (): void => {
    if (dashboard && !dashboard.isDestroyed()) {
      dashboard.show()
      dashboard.focus()
      maybeShowOnboarding()
      return
    }
    dashboard = createDashboard()
    dashboard.once('ready-to-show', () => {
      dashboard?.show()
      maybeShowOnboarding()
    })
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

  const controller = new DictationController(overlay, settings, history, dictionary, snippets)

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
    syncRunner.trigger() // picking up a newly-set sync endpoint reconciles right away
  }

  registerIpc({ settings, history, dictionary, controller, listener, openDashboard, onSettingsChanged })
  createTray({
    openDashboard,
    settings,
    onSettingsChanged,
    quit: () => {
      quitting = true
      syncRunner.stop()
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
    syncRunner.stop()
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
