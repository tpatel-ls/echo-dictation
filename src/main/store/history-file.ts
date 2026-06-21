import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import initSqlJs from 'sql.js'
import type { Database } from 'sql.js'
import { HistoryStore } from './history'
import { DictionaryStore } from './dictionary'

/** Where the sql.js `.wasm` lives at runtime (unpacked resource in prod, node_modules in dev). */
function wasmDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'sql-wasm')
  return join(app.getAppPath(), 'node_modules', 'sql.js', 'dist')
}

export interface HistoryHandle {
  /** The shared sql.js database — the sync SyncTables read/write it directly. */
  db: Database
  store: HistoryStore
  dictionary: DictionaryStore
  /** Immediate, synchronous persist — used on quit. */
  flush: () => void
  /** Debounced persist — used to save records `applyRemote` writes outside the store hook. */
  persist: () => void
}

export interface OpenHistoryOptions {
  /** Fired (alongside the debounced disk persist) whenever a store mutates, so the caller
   * can kick a sync. Store writes already debounce the DB persist; sync coalesces itself. */
  onChange?: () => void
}

/**
 * Open (or create) the on-disk history database. Writes are debounced and atomic
 * (tmp file + rename) so a crash can never leave a half-written DB.
 */
export async function openHistory(opts: OpenHistoryOptions = {}): Promise<HistoryHandle> {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'history.sqlite')

  const SQL = await initSqlJs({ locateFile: (f) => join(wasmDir(), f) })
  const db = existsSync(dbPath) ? new SQL.Database(readFileSync(dbPath)) : new SQL.Database()

  let timer: ReturnType<typeof setTimeout> | null = null
  const persist = (): void => {
    const data = Buffer.from(db.export())
    const tmp = `${dbPath}.tmp`
    writeFileSync(tmp, data)
    renameSync(tmp, dbPath)
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(persist, 400)
  }

  // A store mutation always schedules a disk persist; it may also nudge the sync runner.
  const onStoreChange = (): void => {
    schedule()
    opts.onChange?.()
  }

  const store = new HistoryStore(db, onStoreChange)
  const dictionary = new DictionaryStore(db, onStoreChange)
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    persist()
  }
  return { db, store, dictionary, flush, persist: schedule }
}
