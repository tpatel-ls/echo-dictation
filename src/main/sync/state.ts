import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SyncState } from './client'

// Persistent SyncState for the desktop: the two per-collection sync cursors (server seq)
// and push watermarks (local updated_at) survive restarts in a small JSON file under
// userData. Writes are atomic (tmp + rename) like the history DB, and a corrupt file
// self-heals to empty — sync progress is an optimization, never a source of truth, so
// losing it just re-pulls from 0 (idempotent) rather than crashing the app.

interface PersistedState {
  cursors: Record<string, number>
  watermarks: Record<string, number>
}

export class FileSyncState implements SyncState {
  private cursors: Record<string, number>
  private watermarks: Record<string, number>

  constructor(private readonly path: string) {
    const loaded = this.load()
    this.cursors = loaded.cursors
    this.watermarks = loaded.watermarks
  }

  getCursor(collection: string): number {
    return this.cursors[collection] ?? 0
  }

  setCursor(collection: string, cursor: number): void {
    this.cursors[collection] = cursor
    this.persist()
  }

  getWatermark(collection: string): number {
    return this.watermarks[collection] ?? 0
  }

  setWatermark(collection: string, watermark: number): void {
    this.watermarks[collection] = watermark
    this.persist()
  }

  private load(): PersistedState {
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PersistedState>
        return { cursors: raw.cursors ?? {}, watermarks: raw.watermarks ?? {} }
      }
    } catch {
      /* corrupt file → start fresh; the next write overwrites it */
    }
    return { cursors: {}, watermarks: {} }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    const data: PersistedState = { cursors: this.cursors, watermarks: this.watermarks }
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, this.path)
  }
}
