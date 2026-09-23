import { app, BrowserWindow, dialog, ipcMain, Notification, session } from 'electron'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { SettingsStore } from './store/settings'
import { openHistory } from './store/history-file'
import { SyncTable, SYNC_COLUMNS } from './sync/sync-table'
import { SyncClient, type SyncBinding } from './sync/client'
import { FileSyncState } from './sync/state'
import { SyncRunner } from './sync/runner'
import { createOverlay, createDashboard } from './windows'
import { warmPasteHelper } from './insert/paste-deps'
import { DictationController } from './dictation'
import { HotkeyListener } from './hotkey/listener'
import { registerIpc } from './ipc'
import { createTray, type TrayHandle } from './tray'
import { showMacOnboardingIfNeeded } from './permissions'
import { NativeSpeechRecognizer } from './transcription/native-speech'
import { shouldExitHiddenStartup, shouldOpenSecondInstance, usesMachineWideStartup } from './startup'
import { appendRotatingLog } from './diagnostic-log'
import { transcribe } from './transcription/whisper'
import { MeetingHelperClient } from './meetings/helper-client'
import { MeetingController, type MeetingNotifyKind } from './meetings/controller'
import { finalizeMeeting } from './meetings/finalize'
import { registerMeetingsIpc } from './meetings/ipc'
import { CalendarSource } from './meetings/calendar'
import { IPC, type Settings } from '@shared/types'
import { MEETINGS_IPC, type MeetingEvent } from '@shared/meeting-types'

// Keep the always-on app alive through stray errors — one unhandled exception must
// never take down the tray + global hotkey. Log and continue.
process.on('uncaughtException', (err) => console.error('[echo] uncaughtException:', err))
process.on('unhandledRejection', (reason) => console.error('[echo] unhandledRejection:', reason))

// How often the desktop reconciles with the sync service, on top of the change- and
// launch-triggered passes. Within the 30–60s target from the design spec.
const SYNC_INTERVAL_MS = 45_000
/** Live meeting chunks get a 20 s timeout per attempt (the client's default retries apply). */
const MEETING_LIVE_TIMEOUT_MS = 20_000
/** Quit waits at most this long for a meeting recording to stop cleanly. */
const MEETING_QUIT_TIMEOUT_MS = 5000
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
  const openedHidden = process.argv.includes('--hidden')
  if (shouldExitHiddenStartup(openedHidden, settings.getSettings().launchAtLogin)) {
    app.quit()
    return
  }

  // Sync: a store mutation nudges the runner, but the runner is built after the DB opens,
  // so the change hook forwards through a mutable indirection set just below.
  let nudgeSync = (): void => {}
  const { db, store: history, dictionary, snippets, meetings, voiceprints, flush, persist } = await openHistory({
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
  const syncRunner = new SyncRunner(async (signal) => {
    const s = settings.getSettings()
    const sec = settings.getSecrets()
    if (!s.syncBaseUrl || !sec.syncToken) return // sync not configured yet
    const client = new SyncClient(syncBindings, { baseUrl: s.syncBaseUrl, token: sec.syncToken }, syncState)
    try {
      await client.syncOnce(signal)
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

  const nativeSpeech = new NativeSpeechRecognizer({
    platform: process.platform,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined
  })
  const controller = new DictationController(overlay, settings, history, dictionary, snippets, nativeSpeech)
  warmPasteHelper()

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
    meetingController.applySettings(s)
    if (!overlay.isDestroyed()) overlay.webContents.send(IPC.SETTINGS_CHANGED, s)
    if (dashboard && !dashboard.isDestroyed()) dashboard.webContents.send(IPC.SETTINGS_CHANGED, s)
    syncRunner.trigger() // picking up a newly-set sync endpoint reconciles right away
  }

  // ── Meeting notes (Windows; the controller stays off elsewhere) ──────────────
  const userData = app.getPath('userData')
  const meetingsDir = join(userData, 'meetings')
  // Diagnostics only: meeting ids, durations and error kinds, never titles, names or speech.
  const meetingLog = (message: string): void =>
    appendRotatingLog(join(userData, 'meetings.log'), `${new Date().toISOString()} ${message}\n`)
  const meetingHelper = new MeetingHelperClient({
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    log: meetingLog
  })
  let tray: TrayHandle | null = null
  // Keep notifications referenced until dismissed, or their click handlers can be collected.
  const notifications = new Set<Notification>()

  // The overlay's capsule shows the meeting state (detected, recording, ended, notes ready).
  const emitMeetingEvent = (event: MeetingEvent): void => {
    for (const win of [dashboard, overlay]) {
      if (win && !win.isDestroyed()) win.webContents.send(MEETINGS_IPC.EVENT, event)
    }
  }
  /** Open the dashboard on the Meetings page; a new window gets the request once it has loaded. */
  const showMeeting = (meetingId: number | null): void => {
    const existed = dashboard !== null && !dashboard.isDestroyed()
    openDashboard()
    const win = dashboard
    if (!win || win.isDestroyed()) return
    const navigate = (): void => {
      if (!win.isDestroyed()) win.webContents.send(MEETINGS_IPC.EVENT, { type: 'navigate', meetingId } satisfies MeetingEvent)
    }
    if (existed && !win.webContents.isLoading()) navigate()
    else win.webContents.once('did-finish-load', () => setTimeout(navigate, 500))
  }
  const notifyMeeting = (n: { kind: MeetingNotifyKind; title: string; body: string; meetingId: number | null }): void => {
    // The overlay capsule announces what happened after a meeting (notes ready or failed).
    if ((n.kind === 'notes-ready' || n.kind === 'notes-failed' || n.kind === 'record-failed') && n.meetingId !== null) {
      emitMeetingEvent({ type: 'notice', kind: n.kind, meetingId: n.meetingId })
    }
    // Windows notifications only when the user asked for them (Settings › Meetings).
    if (!settings.getSettings().meetingNotifications || !Notification.isSupported()) return
    const note = new Notification({ title: n.title, body: n.body, silent: true })
    notifications.add(note)
    const forget = (): void => {
      notifications.delete(note)
    }
    note.on('click', () => {
      forget()
      showMeeting(n.meetingId)
    })
    note.on('close', forget)
    note.show()
  }
  const defaultOutputDir = (): string => join(app.getPath('documents'), 'Echo Meetings')
  const osUserName = (): string => {
    try {
      return userInfo().username
    } catch {
      return ''
    }
  }

  // The user's calendar (private iCal address), for naming the people in a meeting.
  const calendar = new CalendarSource({ url: () => settings.getSecrets().calendarIcsUrl, log: meetingLog })

  const meetingController = new MeetingController({
    platform: process.platform,
    settings: () => settings.getSettings(),
    meetings,
    voiceprints,
    dictionary: () => dictionary.list(),
    helper: meetingHelper,
    meetingsDir,
    osUserName,
    calendar,
    log: meetingLog,
    transcribeLive: (wav) => {
      const s = settings.getSettings()
      return transcribe(
        wav,
        { whisperBaseUrl: s.whisperBaseUrl, whisperModel: s.meetingLiveModel },
        settings.getSecrets().whisperApiKey,
        undefined,
        { timeoutMs: MEETING_LIVE_TIMEOUT_MS }
      )
    },
    finalize: (meetingId) =>
      finalizeMeeting(meetingId, {
        meetings,
        voiceprints,
        settings: () => settings.getSettings(),
        secrets: () => settings.getSecrets(),
        dictionary: () => dictionary.list(),
        meetingsDir,
        defaultOutputDir,
        osUserName,
        calendar,
        notify: notifyMeeting,
        updated: (id) => emitMeetingEvent({ type: 'updated', meetingId: id }),
        log: meetingLog
      }),
    ui: {
      emit: emitMeetingEvent,
      notify: notifyMeeting,
      recordingChanged: () => tray?.refresh()
    }
  })
  // The overlay is click-through; while the pointer is over its capsule (meeting controls) it takes
  // clicks. It stays non-focusable, so a click never takes focus from the meeting or a text field.
  ipcMain.on(IPC.OVERLAY_INTERACTIVE, (_e, interactive: unknown) => {
    if (overlay.isDestroyed()) return
    overlay.setIgnoreMouseEvents(interactive !== true, { forward: true })
  })
  registerMeetingsIpc({
    controller: meetingController,
    meetings,
    voiceprints,
    settings: () => settings.getSettings(),
    defaultOutputDir,
    show: showMeeting,
    calendar,
    hasCalendar: () => Boolean(settings.getSecrets().calendarIcsUrl.trim())
  })
  meetingController.start()

  /** Stop a meeting recording cleanly, bounded so a stuck helper can never block quitting. */
  let meetingShutdown: Promise<void> | null = null
  const shutdownMeetings = (): Promise<void> => {
    meetingShutdown ??= Promise.race([
      meetingController.shutdown().catch((e) => meetingLog(`quit: meeting shutdown failed (${(e as Error).name})`)),
      new Promise<void>((resolve) => setTimeout(resolve, MEETING_QUIT_TIMEOUT_MS))
    ]).then(() => flush())
    return meetingShutdown
  }

  registerIpc({ settings, history, dictionary, snippets, controller, listener, openDashboard, onSettingsChanged })
  tray = createTray({
    openDashboard,
    settings,
    onSettingsChanged,
    meeting: {
      live: () => meetingController.live(),
      stop: () => void meetingController.stop(),
      setMicPaused: (paused) => void meetingController.setMicPaused(paused),
      discard: () => {
        void dialog
          .showMessageBox({
            type: 'warning',
            title: 'Discard meeting recording?',
            message: 'Discard this meeting recording?',
            detail: 'The recording and its live transcript are deleted, and no notes are written.',
            buttons: ['Discard', 'Keep recording'],
            defaultId: 1,
            cancelId: 1,
            noLink: true
          })
          .then(({ response }) => {
            if (response === 0) void meetingController.discard()
          })
      }
    },
    quit: () => {
      quitting = true
      void shutdownMeetings().then(() => {
        syncRunner.stop()
        nativeSpeech.shutdown()
        flush()
        app.exit(0)
      })
    }
  })

  applyLoginItem(settings.getSettings().launchAtLogin)

  app.on('second-instance', (_event, argv) => {
    if (shouldOpenSecondInstance(argv)) openDashboard()
  })
  app.on('activate', openDashboard)
  app.on('window-all-closed', () => {
    /* tray app — keep running with no visible windows */
  })
  app.on('before-quit', (event) => {
    // A meeting in progress is stopped cleanly first (its row goes to processing, so the next
    // launch finalises it); quitting resumes once it has.
    if (meetingController.recording && meetingShutdown === null) {
      event.preventDefault()
      quitting = true
      void shutdownMeetings().then(() => app.quit())
      return
    }
    void shutdownMeetings()
    quitting = true
    syncRunner.stop()
    try {
      listener.stop()
    } catch {
      /* ignore */
    }
    nativeSpeech.shutdown()
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
  const programFilesDirs = [process.env.ProgramFiles ?? '', process.env['ProgramFiles(x86)'] ?? '']
  if (usesMachineWideStartup(process.platform, app.isPackaged, process.execPath, programFilesDirs)) {
    // The NSIS installer owns the all-user HKLM entry. Remove a stale HKCU entry so Windows
    // does not launch a second hidden instance and accidentally reveal the dashboard at sign-in.
    app.setLoginItemSettings({ openAtLogin: false })
    return
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: ['--hidden']
  })
}
