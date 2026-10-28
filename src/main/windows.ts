import { app, BrowserWindow, ipcMain, powerMonitor, screen, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/types'
import { OverlayHealth } from './overlay-health'
import { appendRotatingLog } from './diagnostic-log'

const preload = join(__dirname, '../preload/index.js')
const iconPath = join(__dirname, '../../build/icon.png')

type RendererName = 'overlay' | 'dashboard'

function loadRenderer(win: BrowserWindow, name: RendererName): void {
  const base = process.env['ELECTRON_RENDERER_URL']
  if (base) void win.loadURL(`${base}/${name}/index.html`)
  else void win.loadFile(join(__dirname, `../renderer/${name}/index.html`))
}

// Room above the pill for the two-line live transcript bubble; the window is transparent and
// click-through, so the extra area is invisible when the bubble is hidden.
export const OVERLAY_WIDTH = 460
export const OVERLAY_HEIGHT = 124

/** The compact center-bottom bar. Transparent, click-through, and never focusable. */
export function createOverlay(offsetBottom: number): BrowserWindow {
  const win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload,
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  reloadOnCrash(win)
  watchOverlay(win, offsetBottom)
  positionOverlay(win, offsetBottom)
  win.webContents.on('did-finish-load', () => {
    ensureOverlayVisible(win, offsetBottom)
  })
  loadRenderer(win, 'overlay')
  return win
}

function watchOverlay(win: BrowserWindow, offsetBottom: number): void {
  const health = new OverlayHealth(() => {
    if (win.isDestroyed()) return
    appendRotatingLog(join(app.getPath('userData'), 'overlay.log'), `${new Date().toISOString()} heartbeat missing; reloading overlay\n`)
    win.setIgnoreMouseEvents(true, { forward: true })
    // Also replaces an unresponsive renderer; a normal reload can wait on its hung thread.
    win.webContents.forcefullyCrashRenderer()
  }, Date.now())
  const beat = (event: Electron.IpcMainEvent): void => {
    if (event.sender === win.webContents) health.beat(Date.now())
  }
  const reposition = (): void => {
    ensureOverlayVisible(win, offsetBottom)
  }
  const resume = (): void => {
    health.beat(Date.now()) // do not mistake time asleep for an unresponsive renderer
    reposition()
  }
  const timer = setInterval(() => {
    // A healthy renderer can still be hidden or covered after Show Desktop, sleep,
    // or another topmost window. Repair the native window without reloading audio.
    ensureOverlayVisible(win, offsetBottom)
    health.check(Date.now())
  }, 5000)
  timer.unref()
  ipcMain.on(IPC.OVERLAY_READY, beat)
  powerMonitor.on('resume', resume)
  powerMonitor.on('unlock-screen', resume)
  screen.on('display-added', reposition)
  screen.on('display-removed', reposition)
  screen.on('display-metrics-changed', reposition)
  win.once('closed', () => {
    clearInterval(timer)
    ipcMain.removeListener(IPC.OVERLAY_READY, beat)
    powerMonitor.removeListener('resume', resume)
    powerMonitor.removeListener('unlock-screen', resume)
    screen.removeListener('display-added', reposition)
    screen.removeListener('display-removed', reposition)
    screen.removeListener('display-metrics-changed', reposition)
  })
}

/** Restore the indicator without taking keyboard focus from the user's work. */
function ensureOverlayVisible(win: BrowserWindow, offsetBottom: number): void {
  if (win.isDestroyed()) return
  positionOverlay(win, offsetBottom)
  if (win.isMinimized()) win.restore()
  if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver')
  if (!win.isVisible()) win.showInactive()
  // Windows can place a different topmost window above us while isVisible stays true.
  win.moveTop()
}

export function positionOverlay(win: BrowserWindow, offsetBottom: number): void {
  const { workArea } = screen.getPrimaryDisplay()
  const b = win.getBounds()
  const maxOffset = Math.max(0, workArea.height - b.height)
  const offset = Number.isFinite(offsetBottom) ? Math.min(maxOffset, Math.max(0, offsetBottom)) : 28
  const x = Math.round(workArea.x + Math.max(0, (workArea.width - b.width) / 2))
  const y = Math.round(workArea.y + Math.max(0, workArea.height - b.height - offset))
  if (b.x !== x || b.y !== y) win.setPosition(x, y)
}

/** The dashboard / native app. Hidden until shown via tray or first run. */
export function createDashboard(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1060,
    height: 740,
    minWidth: 860,
    minHeight: 580,
    show: false,
    title: 'Echo',
    icon: iconPath,
    backgroundColor: '#0a0c10',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      sandbox: false,
      contextIsolation: true
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  reloadOnCrash(win)
  loadRenderer(win, 'dashboard')
  return win
}

/** Auto-reload a window whose renderer process crashed, so the app self-recovers. */
function reloadOnCrash(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_e, details) => {
    if (!win.isDestroyed() && details.reason !== 'clean-exit') win.reload()
  })
}
