import http from 'node:http'
import type { SyncStore, UpsertInput } from './sync-store'

// ─────────────────────────────────────────────────────────────────────────────
// HTTP surface for the sync service. Routing + auth + validation live in a pure
// `handleSyncRequest` (a parsed request → a status/body) so they're unit-testable
// without a socket; `createServer` is the thin Node adapter that parses the wire
// request, calls the handler, and writes JSON back.
// ─────────────────────────────────────────────────────────────────────────────

const COLLECTIONS = new Set(['transcripts', 'dictionary'])
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000
const MAX_BODY_BYTES = 5_000_000

/** A request parsed off the wire into just what the handler needs. */
export interface ParsedRequest {
  method: string
  collection: string | null
  since: number
  limit: number
  authToken: string | null
  body: unknown
  isHealth: boolean
}

export interface HandlerResponse {
  status: number
  body: unknown
}

/** Pure router: enforces auth, validates the collection/body, and calls the store. */
export function handleSyncRequest(store: SyncStore, token: string, req: ParsedRequest): HandlerResponse {
  if (req.isHealth) return { status: 200, body: { ok: true } }

  if (!token || req.authToken !== token) return { status: 401, body: { error: 'unauthorized' } }

  if (!req.collection || !COLLECTIONS.has(req.collection)) {
    return { status: 404, body: { error: 'unknown collection' } }
  }

  if (req.method === 'GET') {
    const result = store.since(req.collection, sinceCursor(req.since), clampLimit(req.limit))
    return { status: 200, body: result }
  }

  if (req.method === 'POST') {
    const records = parseRecords(req.body)
    if (!records) return { status: 400, body: { error: 'invalid body' } }
    // A push only reports how many rows were applied. Clients advance their PULL cursor
    // solely from GET responses — returning a push-side seq here would be unsafe to treat
    // as a pull cursor (it would skip records other devices wrote at intervening seqs).
    // Re-pulling one's own just-pushed rows is harmless: the merge is LWW-idempotent.
    let applied = 0
    for (const record of records) {
      if (store.upsert(req.collection, record).applied) applied++
    }
    return { status: 200, body: { applied } }
  }

  return { status: 405, body: { error: 'method not allowed' } }
}

/** Build the Node HTTP server that adapts the wire request to `handleSyncRequest`. */
export function createServer(store: SyncStore, token: string): http.Server {
  return http.createServer((req, res) => {
    // A client that disconnects mid-response makes the response stream emit 'error';
    // without a listener that becomes an unhandled exception and kills the service.
    res.on('error', () => {})
    collectBody(req)
      .then((bodyStr) => {
        const out = handleSyncRequest(store, token, parseRequest(req, bodyStr))
        res.writeHead(out.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out.body))
      })
      .catch((e: Error) => {
        const status = e.message === 'body too large' ? 413 : 400
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      })
  })
}

function parseRequest(req: http.IncomingMessage, bodyStr: string): ParsedRequest {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const m = url.pathname.match(/^\/sync\/([^/]+)$/)
  const authHeader = req.headers.authorization ?? ''
  let body: unknown = null
  if (bodyStr) {
    try {
      body = JSON.parse(bodyStr)
    } catch {
      body = undefined // invalid JSON → handler returns 400
    }
  }
  return {
    method: req.method ?? 'GET',
    collection: m ? safeDecode(m[1]) : null,
    since: Number(url.searchParams.get('since') ?? '0'),
    limit: Number(url.searchParams.get('limit') ?? 'NaN'),
    authToken: authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null,
    body,
    isHealth: url.pathname === '/health'
  }
}

/** Buffer the request body with a hard byte cap that actually stops the stream. */
function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length // chunk is a Buffer → real byte length, not UTF-16 units
      if (size > MAX_BODY_BYTES) {
        done = true
        req.destroy() // stop the upload instead of buffering the whole oversized body
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks).toString('utf8'))
      }
    })
    req.on('error', (e: Error) => {
      if (!done) {
        done = true
        reject(e)
      }
    })
  })
}

/** Validate an untrusted push body into store-ready records, or null if malformed. */
function parseRecords(body: unknown): UpsertInput[] | null {
  if (!body || typeof body !== 'object') return null
  const list = (body as { records?: unknown }).records
  if (!Array.isArray(list)) return null
  const out: UpsertInput[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') return null
    const r = item as Record<string, unknown>
    if (
      typeof r.uuid !== 'string' ||
      typeof r.updatedAt !== 'number' ||
      !Number.isFinite(r.updatedAt) || // reject NaN/Infinity (e.g. JSON literal 1e309) — it would freeze LWW
      typeof r.deleted !== 'boolean'
    ) {
      return null
    }
    if (r.payload != null && typeof r.payload !== 'string') return null
    out.push({
      uuid: r.uuid,
      updatedAt: r.updatedAt,
      deleted: r.deleted,
      payload: (r.payload as string | null | undefined) ?? null
    })
  }
  return out
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT
  return Math.min(Math.floor(limit), MAX_LIMIT)
}

/** Normalize an untrusted `since` to a non-negative integer cursor. */
function sinceCursor(since: number): number {
  if (!Number.isFinite(since) || since < 0) return 0
  return Math.floor(since)
}

/** decodeURIComponent that yields null (→ 404) on a malformed escape instead of throwing. */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}
