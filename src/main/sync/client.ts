import { advanceCursor } from '@shared/sync'
import { joinUrl } from '../transcription/whisper'
import type { SyncTable } from './sync-table'

// Pull/push sync orchestration against the tailnet sync service. Pure of Electron — the
// stores (SyncTables) and persistent cursor state are injected, so the whole loop is
// unit-testable against the real server handler in-process. This is the reference the
// Android sync client mirrors.

export class SyncError extends Error {}

export interface SyncConfig {
  baseUrl: string
  token: string
  timeoutMs?: number
}

export interface SyncDeps {
  fetch: typeof fetch
}

/** Per-collection sync progress. Two cursors: a server-seq pull cursor and a local
 * updated_at push watermark. Persistence is the caller's concern (in-memory for tests,
 * userData on the desktop). */
export interface SyncState {
  getCursor(collection: string): number
  setCursor(collection: string, cursor: number): void
  getWatermark(collection: string): number
  setWatermark(collection: string, watermark: number): void
}

export interface SyncBinding {
  name: string
  table: SyncTable
}

interface PullBody {
  records: Array<{ uuid: string; updatedAt: number; deleted: boolean; payload: string | null; seq: number }>
  cursor: number
  hasMore: boolean
}

const PAGE = 200

export class SyncClient {
  constructor(
    private bindings: SyncBinding[],
    private config: SyncConfig,
    private state: SyncState,
    private deps: SyncDeps = { fetch }
  ) {}

  /** One full reconciliation: pull then push for every collection. */
  async syncOnce(signal?: AbortSignal): Promise<void> {
    const errors: unknown[] = []
    for (const binding of this.bindings) {
      try {
        if (signal?.aborted) throw new SyncError('sync cancelled')
        await this.pull(binding, signal)
        await this.push(binding, signal)
      } catch (e) {
        // Isolate collections: a failure in one must not starve the others this pass.
        errors.push(e)
      }
    }
    if (errors.length) throw errors[0]
  }

  private async pull(binding: SyncBinding, signal?: AbortSignal): Promise<void> {
    let cursor = this.state.getCursor(binding.name)
    for (;;) {
      const url = `${joinUrl(this.config.baseUrl, `sync/${binding.name}`)}?since=${cursor}&limit=${PAGE}`
      const res = await this.request(url, { headers: this.authHeader() }, signal)
      if (!res.ok) throw new SyncError(`pull ${binding.name} failed: ${res.status}`)
      const body = (await res.json()) as PullBody
      for (const rec of body.records) {
        try {
          binding.table.applyRemote({
            uuid: rec.uuid,
            updatedAt: rec.updatedAt,
            deleted: rec.deleted,
            data: rec.payload ? (JSON.parse(rec.payload) as Record<string, never>) : {}
          })
        } catch (e) {
          // A malformed/incompatible record (e.g. a future peer schema skew) must not wedge
          // sync. Skip it; the cursor still advances past it below, so it isn't re-pulled.
          console.error(`[sync] skipping bad ${binding.name} record ${rec.uuid}:`, (e as Error).message)
        }
      }
      cursor = advanceCursor(cursor, body.records)
      this.state.setCursor(binding.name, cursor) // persist progress per drained page
      if (!body.hasMore) break
    }
  }

  private async push(binding: SyncBinding, signal?: AbortSignal): Promise<void> {
    const watermark = this.state.getWatermark(binding.name)
    const changes = binding.table.changedSince(watermark)
    if (!changes.length) return
    const records = changes.map((c) => ({
      uuid: c.uuid,
      updatedAt: c.updatedAt,
      deleted: c.deleted,
      payload: JSON.stringify(c.data)
    }))
    const res = await this.request(joinUrl(this.config.baseUrl, `sync/${binding.name}`), {
      method: 'POST',
      headers: { ...this.authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ records })
    }, signal)
    if (!res.ok) throw new SyncError(`push ${binding.name} failed: ${res.status}`)
    const highest = changes.reduce((max, c) => Math.max(max, c.updatedAt), watermark)
    this.state.setWatermark(binding.name, highest)
  }

  private authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.token}` }
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeoutMs = this.config.timeoutMs ?? 15_000
    const controller = new AbortController()
    const cancel = (): void => controller.abort()
    if (signal?.aborted) cancel()
    else signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(cancel, timeoutMs)

    try {
      return await this.deps.fetch(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        if (signal?.aborted) throw new SyncError('sync cancelled')
        throw new SyncError(`sync request timed out after ${timeoutMs}ms`)
      }
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }
}

/** In-memory SyncState — the default cursor store for tests and a base for persistence. */
export class MemorySyncState implements SyncState {
  private cursors = new Map<string, number>()
  private watermarks = new Map<string, number>()
  getCursor(collection: string): number {
    return this.cursors.get(collection) ?? 0
  }
  setCursor(collection: string, cursor: number): void {
    this.cursors.set(collection, cursor)
  }
  getWatermark(collection: string): number {
    return this.watermarks.get(collection) ?? 0
  }
  setWatermark(collection: string, watermark: number): void {
    this.watermarks.set(collection, watermark)
  }
}
