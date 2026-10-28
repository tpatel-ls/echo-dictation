// Run after npm run build: node_modules/.bin/electron scripts/verify-overlay-recovery.cjs
// An isolated overlay only: no keyboard hook, meeting capture, real profile, or network requests.
const { app, ipcMain, powerMonitor, screen } = require('electron')
const { buildSync } = require('esbuild')
const { mkdtempSync, cpSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')

const profile = mkdtempSync(join(tmpdir(), 'echo-overlay-recovery-'))
app.setPath('userData', profile)
const bundle = join(profile, 'bundle')
cpSync(resolve('out/preload'), join(bundle, 'preload'), { recursive: true })
cpSync(resolve('out/renderer'), join(bundle, 'renderer'), { recursive: true })
const entry = join(bundle, 'main/windows.cjs')
buildSync({ entryPoints: ['src/main/windows.ts'], outfile: entry, bundle: true, platform: 'node', external: ['electron'] })

const waitFor = (event, target, timeout = 45_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { target.removeListener(event, done); reject(new Error(`Timeout: ${event}`)) }, timeout)
  const done = () => { clearTimeout(timer); resolve() }
  target.once(event, done)
})

app.whenReady().then(async () => {
  ipcMain.handle('settings:get', () => ({ micMode: 'on-demand', livePreview: false, audioInputDeviceId: '' }))
  ipcMain.handle('meetings:live', () => ({ phase: 'idle' }))
  const { createOverlay } = require(entry)
  const overlay = createOverlay(28)
  const ready = () => waitFor('overlay:ready', ipcMain)
  const assertRendered = async () => {
    assert.equal(await overlay.webContents.executeJavaScript("Boolean(document.querySelector('.ov-pill'))"), true)
    assert.equal(overlay.isVisible(), true)
    assert.equal(overlay.isFocusable(), false)
    assert.equal(overlay.isAlwaysOnTop(), true)
    assert.deepEqual(await overlay.webContents.executeJavaScript(`(() => {
      const pill = document.querySelector('.ov-pill')
      const style = getComputedStyle(pill)
      return { text: pill.textContent, label: pill.getAttribute('aria-label'), width: style.width, height: style.height, opacity: style.opacity }
    })()`), { text: '', label: 'Echo is running', width: '40px', height: '9px', opacity: '0.72' })
  }
  await ready()
  await assertRendered()
  console.log('PASS: overlay mounted and heartbeat received')

  const rendererPid = overlay.webContents.getOSProcessId()
  const mountedAt = await overlay.webContents.executeJavaScript('performance.timeOrigin')
  overlay.hide()
  overlay.setAlwaysOnTop(false)
  overlay.setPosition(-30000, -30000)
  await new Promise(resolve => setTimeout(resolve, 6000))
  await assertRendered()
  const bounds = overlay.getBounds()
  const area = screen.getPrimaryDisplay().workArea
  assert.ok(bounds.x >= area.x && bounds.y >= area.y)
  assert.ok(bounds.x + bounds.width <= area.x + area.width)
  assert.ok(bounds.y + bounds.height <= area.y + area.height)
  assert.equal(overlay.webContents.getOSProcessId(), rendererPid)
  assert.equal(await overlay.webContents.executeJavaScript('performance.timeOrigin'), mountedAt)
  assert.equal(overlay.isFocused(), false)
  console.log('PASS: hidden, off-screen, non-topmost widget restored without reload or focus')

  for (const event of ['resume', 'unlock-screen']) {
    overlay.hide()
    powerMonitor.emit(event)
    await assertRendered()
  }
  console.log('PASS: widget restored after resume and unlock')

  let loaded = ready()
  overlay.webContents.forcefullyCrashRenderer()
  await loaded
  await assertRendered()
  console.log('PASS: crashed renderer recovered')

  loaded = ready()
  // Freeze the renderer event loop; only the main-process watchdog can recover it.
  void overlay.webContents.executeJavaScript('for (;;) {}').catch(() => {})
  await loaded
  await assertRendered()
  console.log('PASS: frozen renderer recovered through missing heartbeat')

  overlay.destroy()
  assert.equal(ipcMain.listenerCount('overlay:ready'), 0)
  console.log('PASS: overlay health listeners cleaned up')
  app.exit(0)
}).catch(error => {
  console.error(error)
  app.exit(1)
})
