import { describe, expect, it } from 'vitest'
import { parseHelperLine, serializeHelperRequest } from '../src/main/meetings/helper-protocol'
import type { HelperLine, HelperRequest } from '@shared/meeting-types'

const micSession = {
  pid: 54276,
  appPid: 29672,
  exe: 'chrome.exe',
  path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  packageFamily: null,
  endpointId: '{0.0.1.00000000}.{abc}',
  endpointName: 'Microphone (USB Audio Device)'
}

const probeResult = {
  type: 'probe-result',
  id: 'p1',
  windows: [
    { pid: 29672, appPid: 29672, exe: 'chrome.exe', title: 'Meet - abc-defg-hij - Google Chrome', className: 'Chrome_WidgetWin_1', minimized: false }
  ],
  tabs: [{ appPid: 29672, exe: 'chrome.exe', name: 'Meet - abc-defg-hij - Microphone recording' }],
  render: [{ pid: 53592, appPid: 29672, exe: 'chrome.exe', endpointId: '{0.0.0.00000000}.{def}', active: true, peak: 0.0421 }]
}

const everyVariant: HelperLine[] = [
  { type: 'ready', version: 1, processLoopback: true },
  { type: 'mic-sessions', sessions: [] },
  { type: 'mic-sessions', sessions: [micSession, { ...micSession, pid: 7, appPid: 7, exe: 'ms-teams.exe', packageFamily: 'MSTeams_8wekyb3d8bbwe' }] },
  probeResult as HelperLine,
  { type: 'probe-result', id: 'p2', windows: [], tabs: [], render: [] },
  { type: 'record-started', id: 'r1', startedAt: 1_790_000_000_000, othersMode: 'process', micName: 'Microphone' },
  { type: 'record-started', id: 'r1', startedAt: 1_790_000_000_000, othersMode: 'system', micName: '' },
  { type: 'record-levels', id: 'r1', mic: 0.12, others: 0, samples: 8000 },
  { type: 'record-warning', id: 'r1', code: 'mic-lost', message: 'The microphone went away' },
  { type: 'record-warning', id: 'r1', code: 'mic-reopened', message: 'm' },
  { type: 'record-warning', id: 'r1', code: 'others-lost', message: 'm' },
  { type: 'record-warning', id: 'r1', code: 'others-retargeted', message: 'm' },
  { type: 'record-warning', id: 'r1', code: 'gap', message: 'm' },
  { type: 'record-stopped', id: 'r1', samples: 320_000 },
  { type: 'record-mic-paused', id: 'r1', paused: true, samples: 48_000 },
  { type: 'record-mic-paused', id: 'r1', paused: false, samples: 96_000 },
  { type: 'error', id: 'p1', code: 'probe-failed', message: 'Probe failed' },
  { type: 'error', code: 'bad-request', message: 'Request is not valid JSON' },
  { type: 'log', message: 'mic-sessions: scan failed' }
]

describe('parseHelperLine', () => {
  it.each(everyVariant.map((line) => [`${line.type} ${JSON.stringify(line).slice(0, 60)}`, line]))(
    'accepts %s',
    (_name, line) => {
      expect(parseHelperLine(JSON.stringify(line))).toEqual(line)
    }
  )

  it('tolerates surrounding whitespace and a trailing carriage return', () => {
    expect(parseHelperLine('  {"type":"log","message":"hi"}\r')).toEqual({ type: 'log', message: 'hi' })
  })

  it('keeps only the contract fields', () => {
    const parsed = parseHelperLine(JSON.stringify({ type: 'record-stopped', id: 'r1', samples: 5, extra: 'x' }))
    expect(parsed).toEqual({ type: 'record-stopped', id: 'r1', samples: 5 })
    const session = parseHelperLine(JSON.stringify({ type: 'mic-sessions', sessions: [{ ...micSession, secret: 1 }] }))
    expect(session).toEqual({ type: 'mic-sessions', sessions: [micSession] })
  })

  it.each([
    ['empty line', ''],
    ['not JSON', '{type:'],
    ['JSON array', '[]'],
    ['JSON string', '"ready"'],
    ['null', 'null'],
    ['no type', '{"version":1}'],
    ['unknown type', '{"type":"hello","message":"x"}'],
    ['ready without version', '{"type":"ready","processLoopback":true}'],
    ['ready with a string version', '{"type":"ready","version":"1","processLoopback":true}'],
    ['ready with a fractional version', '{"type":"ready","version":1.5,"processLoopback":true}'],
    ['ready with a numeric flag', '{"type":"ready","version":1,"processLoopback":1}']
  ])('rejects %s', (_name, line) => {
    expect(parseHelperLine(line)).toBeNull()
  })

  it('rejects a mic session with any malformed field', () => {
    const broken: Record<string, unknown>[] = [
      { ...micSession, pid: -1 },
      { ...micSession, pid: 1.5 },
      { ...micSession, appPid: '1' },
      { ...micSession, exe: 3 },
      { ...micSession, path: null },
      { ...micSession, packageFamily: 5 },
      { ...micSession, endpointId: undefined },
      { ...micSession, endpointName: false }
    ]
    for (const session of broken) {
      expect(parseHelperLine(JSON.stringify({ type: 'mic-sessions', sessions: [session] }))).toBeNull()
    }
    expect(parseHelperLine(JSON.stringify({ type: 'mic-sessions', sessions: {} }))).toBeNull()
    expect(parseHelperLine(JSON.stringify({ type: 'mic-sessions', sessions: [null] }))).toBeNull()
  })

  it('rejects a probe result with any malformed window, tab or render session', () => {
    const variants = [
      { ...probeResult, id: 5 },
      { ...probeResult, windows: [{ ...probeResult.windows[0], minimized: 'no' }] },
      { ...probeResult, windows: [{ ...probeResult.windows[0], className: null }] },
      { ...probeResult, tabs: [{ ...probeResult.tabs[0], name: 1 }] },
      { ...probeResult, tabs: undefined },
      { ...probeResult, render: [{ ...probeResult.render[0], peak: 1.5 }] },
      { ...probeResult, render: [{ ...probeResult.render[0], peak: -0.1 }] },
      { ...probeResult, render: [{ ...probeResult.render[0], active: 1 }] },
      { ...probeResult, render: [{ ...probeResult.render[0], endpointId: 2 }] }
    ]
    for (const line of variants) expect(parseHelperLine(JSON.stringify(line))).toBeNull()
  })

  it('rejects malformed recording lines', () => {
    const lines = [
      { type: 'record-started', id: 'r1', startedAt: 'now', othersMode: 'process', micName: '' },
      { type: 'record-started', id: 'r1', startedAt: 1, othersMode: 'everything', micName: '' },
      { type: 'record-started', startedAt: 1, othersMode: 'process', micName: '' },
      { type: 'record-levels', id: 'r1', mic: 2, others: 0, samples: 1 },
      { type: 'record-levels', id: 'r1', mic: 0, others: 0, samples: -1 },
      { type: 'record-levels', id: 'r1', mic: 0, others: 0, samples: 1.5 },
      { type: 'record-warning', id: 'r1', code: 'fire', message: 'm' },
      { type: 'record-warning', id: 'r1', code: 'gap' },
      { type: 'record-stopped', id: 'r1' },
      { type: 'record-stopped', id: 'r1', samples: Number.MAX_VALUE },
      { type: 'record-mic-paused', id: 'r1', paused: 'yes', samples: 1 },
      { type: 'record-mic-paused', id: 'r1', paused: true },
      { type: 'record-mic-paused', paused: true, samples: 1 }
    ]
    for (const line of lines) expect(parseHelperLine(JSON.stringify(line))).toBeNull()
  })

  it('rejects malformed errors and logs', () => {
    expect(parseHelperLine('{"type":"error","id":7,"code":"x","message":"m"}')).toBeNull()
    expect(parseHelperLine('{"type":"error","id":null,"code":"x","message":"m"}')).toBeNull()
    expect(parseHelperLine('{"type":"error","message":"m"}')).toBeNull()
    expect(parseHelperLine('{"type":"log"}')).toBeNull()
  })
})

describe('serializeHelperRequest', () => {
  const requests: HelperRequest[] = [
    { type: 'probe', id: 'p1', exes: ['chrome.exe', 'ms-teams.exe'] },
    { type: 'record-start', id: 'r1', dir: 'C:\\Users\\me\\AppData\\Roaming\\echo\\meetings\\u1', otherPids: [53592], micEndpointId: null },
    { type: 'record-start', id: 'r2', dir: 'D:\\m', otherPids: [], micEndpointId: '{0.0.1.00000000}.{abc}' },
    { type: 'record-retarget', id: 'r1', otherPids: [1, 2] },
    { type: 'record-stop', id: 'r1' },
    { type: 'record-mic-pause', id: 'r1', paused: true },
    { type: 'record-mic-pause', id: 'r1', paused: false },
    { type: 'shutdown' }
  ]

  it.each(requests.map((request) => [request.type, request]))('writes %s as one newline-terminated JSON line', (_name, request) => {
    const line = serializeHelperRequest(request)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(line)).toEqual(request)
  })

  it('keeps paths with newlines and quotes on one line', () => {
    const line = serializeHelperRequest({ type: 'record-start', id: 'r', dir: 'C:\\a\n"b"', otherPids: [], micEndpointId: null })
    expect(line.split('\n')).toHaveLength(2)
    expect(JSON.parse(line).dir).toBe('C:\\a\n"b"')
  })

  it('drops fields that are not part of the request', () => {
    const request = { type: 'record-stop', id: 'r1', dir: 'x' } as unknown as HelperRequest
    expect(JSON.parse(serializeHelperRequest(request))).toEqual({ type: 'record-stop', id: 'r1' })
  })
})
