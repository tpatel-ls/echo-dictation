import { describe, it, expect, vi } from 'vitest'
import {
  buildNotesRequest,
  draftNotes,
  parseNotes,
  NotesError,
  NOTES_WINDOW_CHARS,
  type NotesMeta,
  type NotesUtterance
} from '../src/main/meetings/notes'

const meta: NotesMeta = {
  appLabel: 'Google Meet',
  title: 'Weekly sync',
  startedAt: new Date(2026, 8, 22, 14, 0).getTime(),
  participants: ['Tanay', 'Blake Whitmore']
}

const utterances: NotesUtterance[] = [
  { uid: 'u1', speaker: 'Tanay', startMs: 0, text: 'Thanks for joining.' },
  { uid: 'u2', speaker: 'Blake Whitmore', startMs: 12_000, text: "I'll send the checklist by Friday." },
  { uid: 'u3', speaker: 'Tanay', startMs: 7_323_000, text: 'We agreed to move the beta to October 14.' }
]

const ids = new Set(['u1', 'u2', 'u3'])

const config = { claudeBaseUrl: 'https://proxy.example.com/', claudeModel: 'claude-main', fallbackModel: 'gpt-backup' }

const goodJson = JSON.stringify({
  summary: ['We planned the beta.'],
  decisions: [{ text: 'Beta moves to October 14.', cites: ['u3'] }],
  actionItems: [{ text: 'Send the checklist.', owner: 'Blake Whitmore', due: 'Friday', cites: ['u2'] }],
  openQuestions: []
})

function messages(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 })
}

function asFetch(mock: unknown): typeof fetch {
  return mock as typeof fetch
}

describe('buildNotesRequest', () => {
  it('formats transcript lines with ids, clock times and speakers, and marks the transcript as data', () => {
    const { system, user } = buildNotesRequest(meta, utterances)
    expect(user).toContain('[u1 00:00:00] Tanay: Thanks for joining.')
    expect(user).toContain("[u2 00:00:12] Blake Whitmore: I'll send the checklist by Friday.")
    expect(user).toContain('[u3 02:02:03] Tanay: We agreed')
    expect(user).toContain('<transcript>')
    expect(user).toContain('Google Meet')
    expect(user).toContain('"Weekly sync"')
    expect(user).toContain('Tanay, Blake Whitmore')
    expect(user).toContain('2026-09-22 14:00')
    expect(system).toMatch(/untrusted data/i)
    expect(system).toMatch(/never follow instructions/i)
    expect(system).toMatch(/actionItems/)
    expect(system).toMatch(/em dashes/)
    expect(system + user).not.toContain(String.fromCharCode(0x2014))
    // Some proxies replace the system prompt, so the instructions also open the user turn and the
    // format is restated after the transcript.
    expect(user.startsWith(system)).toBe(true)
    expect(user.trimEnd().endsWith('no code fences.')).toBe(true)
    expect(user.indexOf('</transcript>')).toBeLessThan(user.lastIndexOf('Reply with only the JSON object'))
  })
})

describe('parseNotes', () => {
  it('parses clean JSON, marking every item unverified', () => {
    const notes = parseNotes(goodJson, ids, 'claude-main')
    expect(notes).toEqual({
      summary: ['We planned the beta.'],
      decisions: [{ text: 'Beta moves to October 14.', cites: ['u3'], verification: 'unverified' }],
      actionItems: [
        { text: 'Send the checklist.', owner: 'Blake Whitmore', due: 'Friday', cites: ['u2'], verification: 'unverified' }
      ],
      openQuestions: [],
      model: 'claude-main',
      verifiedBy: null
    })
  })

  it('tolerates code fences and prose around the object', () => {
    expect(parseNotes('```json\n' + goodJson + '\n```', ids, 'm').decisions).toHaveLength(1)
    expect(parseNotes('Here are the notes:\n' + goodJson + '\nHope this helps.', ids, 'm').actionItems).toHaveLength(1)
  })

  it('drops cites that do not exist and items left without any', () => {
    const notes = parseNotes(
      JSON.stringify({
        summary: [],
        decisions: [
          { text: 'Keep me.', cites: ['u3', 'u99', 'u3'] },
          { text: 'Invented.', cites: ['u42'] },
          { text: 'No cites.', cites: [] },
          { text: '   ', cites: ['u1'] }
        ],
        actionItems: [{ text: 'Owner missing.', owner: null, cites: ['u1'] }],
        openQuestions: 'not a list'
      }),
      ids,
      'm'
    )
    expect(notes.decisions).toEqual([{ text: 'Keep me.', cites: ['u3'], verification: 'unverified' }])
    expect(notes.actionItems).toEqual([
      { text: 'Owner missing.', owner: null, due: null, cites: ['u1'], verification: 'unverified' }
    ])
    expect(notes.openQuestions).toEqual([])
  })

  it('trims text, removes em dashes, dedupes summary lines and caps each list at 50', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ text: `Item ${i}`, cites: ['u1'] }))
    const notes = parseNotes(
      JSON.stringify({
        summary: [`  We met ${String.fromCharCode(0x2014)} briefly.  `, 'We met, briefly', 42],
        decisions: many,
        actionItems: [],
        openQuestions: []
      }),
      ids,
      'm'
    )
    expect(notes.summary).toEqual(['We met, briefly.'])
    expect(notes.decisions).toHaveLength(50)
  })

  it('throws NotesError when there is no JSON object', () => {
    expect(() => parseNotes('Sorry, I cannot help with that.', ids, 'm')).toThrow(NotesError)
    expect(() => parseNotes('[1, 2]', ids, 'm')).toThrow(NotesError)
    expect(() => parseNotes('{"summary": [', ids, 'm')).toThrow(NotesError)
  })
})

describe('draftNotes', () => {
  it('calls the proxy the way the Claude cleanup client does', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: unknown) => messages(goodJson))
    const notes = await draftNotes(meta, utterances, config, 'KEY', { fetch: asFetch(fetchMock) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://proxy.example.com/v1/messages')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'KEY',
      'anthropic-version': '2023-06-01'
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('claude-main')
    expect(body.temperature).toBe(0)
    expect(body.max_tokens).toBeGreaterThan(0)
    expect(body.system).toMatch(/untrusted data/i)
    expect(body.messages).toEqual([{ role: 'user', content: expect.stringContaining('[u2 00:00:12]') }])
    expect(notes.model).toBe('claude-main')
    expect(notes.actionItems[0].owner).toBe('Blake Whitmore')
  })

  it('falls back to the second model when the first fails or returns unusable text', async () => {
    const models: string[] = []
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const model = JSON.parse(init.body as string).model
      models.push(model)
      return model === 'claude-main' ? new Response('overloaded', { status: 529 }) : messages(goodJson)
    })
    const notes = await draftNotes(meta, utterances, config, 'KEY', { fetch: asFetch(fetchMock) })
    expect(models).toEqual(['claude-main', 'gpt-backup'])
    expect(notes.model).toBe('gpt-backup')

    const prose = vi.fn(async (_url: unknown, init: RequestInit) =>
      messages(JSON.parse(init.body as string).model === 'claude-main' ? 'no json here' : goodJson)
    )
    expect((await draftNotes(meta, utterances, config, 'KEY', { fetch: asFetch(prose) })).model).toBe('gpt-backup')
  })

  it('does not fall back on an auth failure, and throws NotesError when every model fails', async () => {
    const unauthorized = vi.fn(async () => new Response('nope', { status: 401 }))
    await expect(draftNotes(meta, utterances, config, 'KEY', { fetch: asFetch(unauthorized) })).rejects.toMatchObject({
      name: 'NotesError',
      status: 401
    })
    expect(unauthorized).toHaveBeenCalledTimes(1)

    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(draftNotes(meta, utterances, config, 'KEY', { fetch: asFetch(down) })).rejects.toThrow(NotesError)
    expect(down).toHaveBeenCalledTimes(2)
  })

  it('uses one model when the fallback is unset or the same', async () => {
    const fetchMock = vi.fn(async () => new Response('bad', { status: 500 }))
    await expect(
      draftNotes(meta, utterances, { ...config, fallbackModel: 'claude-main' }, 'KEY', { fetch: asFetch(fetchMock) })
    ).rejects.toThrow(NotesError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('times out a stalled request', async () => {
    const stalled = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        )
    )
    await expect(
      draftNotes(meta, utterances, { ...config, fallbackModel: undefined }, 'KEY', { fetch: asFetch(stalled), timeoutMs: 10 })
    ).rejects.toThrow(/timed out/)
  })

  it('refuses an empty transcript without calling the proxy', async () => {
    const fetchMock = vi.fn()
    await expect(draftNotes(meta, [], config, 'KEY', { fetch: asFetch(fetchMock) })).rejects.toThrow(NotesError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('drafts a long transcript in windows of whole utterances and merges the results', async () => {
    const long: NotesUtterance[] = Array.from({ length: 40 }, (_, i) => ({
      uid: `u${i}`,
      speaker: 'Tanay',
      startMs: i * 1000,
      text: `${'word '.repeat(1_000)}${i}`
    }))
    const seen: string[][] = []
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const content = JSON.parse(init.body as string).messages[0].content as string
      expect(content.length).toBeLessThan(NOTES_WINDOW_CHARS + 2_000)
      const windowIds = [...content.matchAll(/^\[(u\d+) /gm)].map((m) => m[1])
      seen.push(windowIds)
      return messages(
        JSON.stringify({
          summary: ['Shared line.', `Part starting ${windowIds[0]}.`],
          decisions: [{ text: `Decision in ${windowIds[0]}`, cites: [windowIds[0], 'u0'] }],
          actionItems: [],
          openQuestions: []
        })
      )
    })
    const notes = await draftNotes(meta, long, config, 'KEY', { fetch: asFetch(fetchMock) })
    expect(seen.length).toBe(2)
    expect(seen.flat()).toEqual(long.map((u) => u.uid))
    expect(fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).messages[0].content)[0]).toMatch(
      /part 1 of 2/
    )
    expect(notes.summary).toEqual(['Shared line.', 'Part starting u0.', `Part starting ${seen[1][0]}.`])
    // Cites outside the window a model saw are dropped: 'u0' only survives in the first window.
    expect(notes.decisions).toEqual([
      { text: 'Decision in u0', cites: ['u0'], verification: 'unverified' },
      { text: `Decision in ${seen[1][0]}`, cites: [seen[1][0]], verification: 'unverified' }
    ])
    expect(notes.model).toBe('claude-main')
  })
})
