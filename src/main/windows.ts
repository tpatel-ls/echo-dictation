import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'

const preload = join(__dirname, '../preload/index.js')
const iconPath = join(__dirname, '../../build/icon.png')

type RendererName = 'overlay' | 'dashboard'

function loadRenderer(win: BrowserWindow, name: RendererName): void {
  const base = process.env['ELECTRON_RENDERER_URL']
  if (base) void win.loadURL(`${base}/${name}/index.html`)
  else void win.loadFile(join(__dirname, `../renderer/${name}/index.html`))
}

export const OVERLAY_WIDTH = 420
export const OVERLAY_HEIGHT = 150

/** The center-bottom pill. Transparent, click-through, and — critically — never focusable. */
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
  positionOverlay(win, offsetBottom)
  loadRenderer(win, 'overlay')
  return win
}

export function positionOverlay(win: BrowserWindow, offsetBottom: number): void {
  const { workArea } = screen.getPrimaryDisplay()
  const b = win.getBounds()
  const x = Math.round(workArea.x + (workArea.width - b.width) / 2)
  const y = Math.round(workArea.y + workArea.height - b.height - offsetBottom)
  win.setPosition(x, y)
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
