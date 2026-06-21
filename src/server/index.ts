import { join } from 'node:path'
import { openSyncDb } from './db'
import { createServer } from './http'

// Entry point for the Echo sync service. Reads config from the environment, opens the
// persistent store, and serves the REST API. Intended to run on the user's always-on
// tailnet host (e.g. the GB10 that runs the Whisper node). Thin wiring — logic in db.ts/http.ts.

async function main(): Promise<void> {
  const port = Number(process.env.SYNC_PORT ?? '8787')
  // Default binds all interfaces; on a tailnet, set SYNC_HOST to the tailnet IP to be safe.
  const host = process.env.SYNC_HOST ?? '0.0.0.0'
  const token = process.env.SYNC_TOKEN ?? ''
  const dbPath = process.env.SYNC_DB ?? join(process.cwd(), 'sync-data', 'sync.sqlite')
  const wasmDir = process.env.SYNC_WASM_DIR ?? join(process.cwd(), 'node_modules', 'sql.js', 'dist')

  if (!token) {
    console.error('[echo-sync] SYNC_TOKEN is required (a shared bearer secret). Refusing to start.')
    process.exit(1)
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[echo-sync] SYNC_PORT must be an integer 0-65535 (got "${process.env.SYNC_PORT}").`)
    process.exit(1)
  }

  const handle = await openSyncDb(dbPath, wasmDir)
  const server = createServer(handle.store, token)

  server.listen(port, host, () => {
    console.log(`[echo-sync] listening on http://${host}:${port}  (db: ${dbPath})`)
  })

  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return // a second signal must not re-run close() / export a freed DB
    closing = true
    console.log(`[echo-sync] ${signal} — flushing and exiting`)
    server.close(() => {
      handle.close()
      process.exit(0)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((e) => {
  console.error('[echo-sync] fatal:', e)
  process.exit(1)
})
