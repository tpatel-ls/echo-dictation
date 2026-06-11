// Non-intrusive runtime check: load native modules under Electron's ABI and init
// sql.js. Starts NO keyboard hook, NO window, touches NO clipboard. Run via:
//   npx electron scripts/smoke-electron.cjs
const { app } = require('electron')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  const results = {}
  try {
    require('uiohook-napi')
    results.uiohook = 'ok (loaded)'
  } catch (e) {
    results.uiohook = 'FAIL: ' + e.message
  }
  try {
    require('@nut-tree-fork/nut-js')
    results.nutjs = 'ok (loaded)'
  } catch (e) {
    results.nutjs = 'FAIL: ' + e.message
  }
  try {
    const initSqlJs = require('sql.js')
    const path = require('path')
    const SQL = await initSqlJs({
      locateFile: (f) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', f)
    })
    const db = new SQL.Database()
    db.run('CREATE TABLE t(x)')
    db.run('INSERT INTO t VALUES (42)')
    const r = db.exec('SELECT x FROM t')
    results.sqljs = r[0].values[0][0] === 42 ? 'ok (query 42)' : 'FAIL: bad query'
  } catch (e) {
    results.sqljs = 'FAIL: ' + e.message
  }
  try {
    const { safeStorage } = require('electron')
    results.safeStorage = safeStorage.isEncryptionAvailable() ? 'available' : 'unavailable (plaintext fallback)'
  } catch (e) {
    results.safeStorage = 'FAIL: ' + e.message
  }
  console.log('SMOKE_RESULTS ' + JSON.stringify(results, null, 2))
  app.quit()
})
