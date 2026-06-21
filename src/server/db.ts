import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SyncStore } from './sync-store'

// On-disk persistence for the sync service. Mirrors the desktop's history-file.ts:
// writes are debounced and atomic (tmp file + rename) so a crash never leaves a
// half-written DB. No Electron — paths and the wasm location are passed in.

export interface SyncDbHandle {
  store: SyncStore
  /** Force an immediate persist (e.g. on shutdown). */
  flush: () => void
  /** Flush and release the database. */
  close: () => void
}

export async function openSyncDb(dbPath: string, wasmDir: string): Promise<SyncDbHandle> {
  const SQL = await initSqlJs({ locateFile: (f) => join(wasmDir, f) })
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = loadDatabase(SQL, dbPath)

  let timer: ReturnType<typeof setTimeout> | null = null
  const persist = (): void => {
    try {
      const data = Buffer.from(db.export())
      const tmp = `${dbPath}.tmp`
      writeFileSync(tmp, data)
      renameSync(tmp, dbPath)
    } catch (e) {
      // A transient write failure (ENOSPC, a file lock, a permissions blip) must not crash a
      // supervised service — log and keep serving; the next change reschedules a persist.
      console.error(`[echo-sync] failed to persist ${dbPath}:`, (e as Error).message)
    }
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(persist, 400)
    timer.unref() // a lone pending persist must not keep the process alive
  }
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    persist()
  }

  const store = new SyncStore(db, schedule)
  return {
    store,
    flush,
    close: () => {
      flush()
      db.close()
    }
  }
}

/** Load the DB, recovering from a corrupt file by moving it aside and starting fresh. */
function loadDatabase(SQL: SqlJsStatic, dbPath: string): Database {
  if (!existsSync(dbPath)) return new SQL.Database()
  let db: Database | null = null
  try {
    db = new SQL.Database(readFileSync(dbPath))
    // Touch the schema page so a corrupt/non-sqlite file fails HERE: sql.js loads lazily,
    // so otherwise the error would only surface later in the SyncStore constructor, past
    // this guard, and crash-loop the service.
    db.run('SELECT name FROM sqlite_master LIMIT 1')
    return db
  } catch (e) {
    // A corrupt/unreadable file must not crash-loop a supervised service. Preserve it for
    // forensics and start fresh so sync self-heals instead of dying on every relaunch.
    try {
      db?.close()
    } catch {
      /* ignore */
    }
    const backup = `${dbPath}.corrupt-${Date.now()}`
    try {
      renameSync(dbPath, backup)
    } catch {
      /* best effort — if we can't move it aside, we still start fresh in memory */
    }
    console.error(
      `[echo-sync] could not open ${dbPath} (${(e as Error).message}); moved aside to ${backup}, starting fresh`
    )
    return new SQL.Database()
  }
}
