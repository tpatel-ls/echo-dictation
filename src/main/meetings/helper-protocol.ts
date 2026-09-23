// JSON-lines protocol of EchoMeetingHelper.exe. The helper is a separate binary that can lag
// behind (or run ahead of) this build, so every line is validated field by field and rebuilt with
// only the contract's fields; anything malformed or unknown is dropped as null.

import type {
  HelperBrowserTab,
  HelperLine,
  HelperRequest,
  HelperWindow,
  MicSession,
  RecordWarningCode,
  RenderSession
} from '@shared/meeting-types'

type Json = Record<string, unknown>

const WARNING_CODES: readonly RecordWarningCode[] = ['mic-lost', 'mic-reopened', 'others-lost', 'others-retargeted', 'gap']

export function parseHelperLine(line: string): HelperLine | null {
  const text = line.trim()
  if (!text) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(value) || typeof value.type !== 'string') return null
  try {
    return parseVariant(value)
  } catch (error) {
    if (error instanceof Malformed) return null
    throw error
  }
}

export function serializeHelperRequest(req: HelperRequest): string {
  return `${JSON.stringify(requestFields(req))}\n`
}

function requestFields(req: HelperRequest): HelperRequest {
  switch (req.type) {
    case 'probe':
      return { type: 'probe', id: req.id, exes: req.exes }
    case 'record-start':
      return { type: 'record-start', id: req.id, dir: req.dir, otherPids: req.otherPids, micEndpointId: req.micEndpointId }
    case 'record-retarget':
      return { type: 'record-retarget', id: req.id, otherPids: req.otherPids }
    case 'record-stop':
      return { type: 'record-stop', id: req.id }
    case 'record-mic-pause':
      return { type: 'record-mic-pause', id: req.id, paused: req.paused }
    case 'shutdown':
      return { type: 'shutdown' }
  }
}

function parseVariant(v: Json): HelperLine | null {
  switch (v.type) {
    case 'ready':
      return { type: 'ready', version: int(v.version), processLoopback: bool(v.processLoopback) }
    case 'mic-sessions':
      return { type: 'mic-sessions', sessions: list(v.sessions, micSession) }
    case 'probe-result':
      return {
        type: 'probe-result',
        id: str(v.id),
        windows: list(v.windows, helperWindow),
        tabs: list(v.tabs, browserTab),
        render: list(v.render, renderSession)
      }
    case 'record-started': {
      const othersMode = v.othersMode
      if (othersMode !== 'process' && othersMode !== 'system') throw new Malformed()
      return { type: 'record-started', id: str(v.id), startedAt: num(v.startedAt), othersMode, micName: str(v.micName) }
    }
    case 'record-levels':
      return { type: 'record-levels', id: str(v.id), mic: unit(v.mic), others: unit(v.others), samples: int(v.samples) }
    case 'record-warning': {
      const code = v.code
      if (!WARNING_CODES.includes(code as RecordWarningCode)) throw new Malformed()
      return { type: 'record-warning', id: str(v.id), code: code as RecordWarningCode, message: str(v.message) }
    }
    case 'record-stopped':
      return { type: 'record-stopped', id: str(v.id), samples: int(v.samples) }
    case 'record-mic-paused':
      return { type: 'record-mic-paused', id: str(v.id), paused: bool(v.paused), samples: int(v.samples) }
    case 'error':
      return 'id' in v
        ? { type: 'error', id: str(v.id), code: str(v.code), message: str(v.message) }
        : { type: 'error', code: str(v.code), message: str(v.message) }
    case 'log':
      return { type: 'log', message: str(v.message) }
    default:
      return null
  }
}

function micSession(v: unknown): MicSession {
  const o = obj(v)
  const packageFamily = o.packageFamily === null ? null : str(o.packageFamily)
  return {
    pid: int(o.pid),
    appPid: int(o.appPid),
    exe: str(o.exe),
    path: str(o.path),
    packageFamily,
    endpointId: str(o.endpointId),
    endpointName: str(o.endpointName)
  }
}

function helperWindow(v: unknown): HelperWindow {
  const o = obj(v)
  return {
    pid: int(o.pid),
    appPid: int(o.appPid),
    exe: str(o.exe),
    title: str(o.title),
    className: str(o.className),
    minimized: bool(o.minimized)
  }
}

function browserTab(v: unknown): HelperBrowserTab {
  const o = obj(v)
  return { appPid: int(o.appPid), exe: str(o.exe), name: str(o.name) }
}

function renderSession(v: unknown): RenderSession {
  const o = obj(v)
  return {
    pid: int(o.pid),
    appPid: int(o.appPid),
    exe: str(o.exe),
    endpointId: str(o.endpointId),
    active: bool(o.active),
    peak: unit(o.peak)
  }
}

class Malformed extends Error {}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function obj(v: unknown): Json {
  if (!isObject(v)) throw new Malformed()
  return v
}

function list<T>(v: unknown, item: (v: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new Malformed()
  return v.map(item)
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new Malformed()
  return v
}

function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Malformed()
  return v
}

function num(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Malformed()
  return v
}

/** Non-negative safe integer: PIDs, sample counts, protocol version. */
function int(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Malformed()
  return v
}

/** Level or peak in 0..1. */
function unit(v: unknown): number {
  const n = num(v)
  if (n < 0 || n > 1) throw new Malformed()
  return n
}
