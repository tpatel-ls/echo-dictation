import { describe, it, expect, vi } from 'vitest'
import { typesafeClient, verifyNotes, TypesafeError, type JevAsk, type JevQuestion } from '../src/main/meetings/typesafe'
import type { NotesUtterance } from '../src/main/meetings/notes'
import type { MeetingNotes } from '@shared/meeting-types'

const question: JevQuestion = {
  type: 'choice',
  instructions: 'Is it supported?',
  criteria: { supported: 'yes', insufficient: null, contradicted: null, unrelated: null }
}

function answer(probabilities: Record<string, number>, choice = 'supported', confidence = 0.9) {
  return { type: 'choice', choice, confidence, probabilities }
}

const good = answer({ supported: 0.9, insufficient: 0.05, contradicted: 0.03, unrelated: 0.02 })

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function asFetch(mock: unknown): typeof fetch {
  return mock as typeof fetch
}

const noDelay = async (): Promise<void> => {}

describe('typesafeClient', () => {
  it('posts the model, state and questions with a bearer key and no redirects', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: unknown) => ok({ model: 'jev-1.13.0', answers: { q: good }, usage: {} }))
    const ask = typesafeClient('TS_KEY', asFetch(fetchMock))
    const out = await ask({ segments: { u1: 'hi' } }, { q: question })
    expect(out).toEqual({ model: 'jev-1.13.0', answers: { q: good } })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.headers).toEqual({ authorization: 'Bearer TS_KEY', 'content-type': 'application/json' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'jev-latest',
      state: { segments: { u1: 'hi' } },
      questions: { q: question }
    })
  })

  it('uses a pinned model when given', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: unknown) => ok({ model: 'jev-1.13.0', answers: { q: good } }))
    await typesafeClient('K', asFetch(fetchMock), { model: 'jev-1.13.0' })({}, { q: question })
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).model).toBe('jev-1.13.0')
  })

  it('refuses to call without a key', async () => {
    const fetchMock = vi.fn()
    await expect(typesafeClient('', asFetch(fetchMock))({}, { q: question })).rejects.toThrow(TypesafeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts probability sums within 0.03 of 1 (JEV rounds to 2 decimals)', async () => {
    const within = answer({ supported: 0.4, insufficient: 0.3, contradicted: 0.2, unrelated: 0.08 }) // 0.98
    const ask = typesafeClient('K', asFetch(async () => ok({ model: 'm', answers: { q: within } })))
    await expect(ask({}, { q: question })).resolves.toBeTruthy()
    const high = answer({ supported: 0.42, insufficient: 0.3, contradicted: 0.2, unrelated: 0.1 }) // 1.02
    const askHigh = typesafeClient('K', asFetch(async () => ok({ model: 'm', answers: { q: high } })))
    await expect(askHigh({}, { q: question })).resolves.toBeTruthy()
  })

  it.each([
    ['a question missing an answer', { model: 'm', answers: {} }],
    ['no model id', { answers: { q: good } }],
    ['a choice that is not a criterion', { model: 'm', answers: { q: answer({ supported: 1, insufficient: 0, contradicted: 0, unrelated: 0 }, 'maybe') } }],
    ['a missing probability key', { model: 'm', answers: { q: answer({ supported: 0.9, insufficient: 0.1, contradicted: 0 }) } }],
    ['an extra probability key', { model: 'm', answers: { q: answer({ supported: 0.9, insufficient: 0.1, contradicted: 0, unrelated: 0, other: 0 }) } }],
    ['probabilities summing far from 1', { model: 'm', answers: { q: answer({ supported: 0.5, insufficient: 0.2, contradicted: 0.2, unrelated: 0.04 }) } }],
    ['a probability above the chosen one', { model: 'm', answers: { q: answer({ supported: 0.3, insufficient: 0.6, contradicted: 0.05, unrelated: 0.05 }) } }],
    ['a probability out of range', { model: 'm', answers: { q: answer({ supported: 1.5, insufficient: -0.5, contradicted: 0, unrelated: 0 }) } }],
    ['a non-choice answer', { model: 'm', answers: { q: { ...good, type: 'noul' } } }],
    ['a confidence out of range', { model: 'm', answers: { q: { ...good, confidence: 2 } } }]
  ])('rejects %s without retrying', async (_label, body) => {
    const fetchMock = vi.fn(async () => ok(body))
    const ask = typesafeClient('K', asFetch(fetchMock), { delay: noDelay })
    await expect(ask({}, { q: question })).rejects.toThrow('Invalid TypeSafe response')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([408, 429, 500, 503, 529])('retries %i up to twice, then gives up', async (status) => {
    const fetchMock = vi.fn(async () => new Response('secret provider detail', { status }))
    const delay = vi.fn(noDelay)
    const ask = typesafeClient('K', asFetch(fetchMock), { delay })
    const err = await ask({}, { q: question }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TypesafeError)
    expect((err as TypesafeError).status).toBe(status)
    expect((err as Error).message).not.toContain('secret provider detail')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(delay).toHaveBeenCalledTimes(2)
  })

  it.each([400, 401, 403, 404, 422])('never retries %i', async (status) => {
    const fetchMock = vi.fn(async () => new Response('{"detail":"questions.q bad"}', { status }))
    const ask = typesafeClient('K', asFetch(fetchMock), { delay: noDelay })
    const err = await ask({ private: 'meeting speech' }, { q: question }).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'TypesafeError', status })
    expect((err as Error).message).not.toMatch(/detail|meeting speech/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('recovers when a retry succeeds, honouring retry-after', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(ok({ model: 'm', answers: { q: good } }))
    const delay = vi.fn(async (_ms: number) => {})
    const out = await typesafeClient('K', asFetch(fetchMock), { delay })({}, { q: question })
    expect(out.model).toBe('m')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(delay.mock.calls[0][0]).toBe(2000)
    expect(delay.mock.calls[1][0]).toBeGreaterThan(0)
    expect(delay.mock.calls[1][0]).toBeLessThanOrEqual(1000)
  })

  it('times out each attempt and retries network failures', async () => {
    const stalled = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    )
    const ask = typesafeClient('K', asFetch(stalled), { timeoutMs: 10, retries: 1, delay: noDelay })
    await expect(ask({}, { q: question })).rejects.toThrow('TypeSafe timed out')
    expect(stalled).toHaveBeenCalledTimes(2)
  })
})

// ── verifyNotes ───────────────────────────────────────────────────────────────

const utterances: NotesUtterance[] = Array.from({ length: 10 }, (_, i) => ({
  uid: `u${i}`,
  speaker: i % 2 ? 'Blake Whitmore' : 'Tanay',
  startMs: i * 61_000,
  text: `line ${i}`
}))

function notes(overrides: Partial<MeetingNotes> = {}): MeetingNotes {
  return {
    summary: ['We talked.'],
    decisions: [{ text: 'Ship it.', cites: ['u5'], verification: 'unverified' }],
    actionItems: [
      { text: 'Send the checklist.', owner: 'Blake Whitmore', due: 'Friday', cites: ['u1'], verification: 'unverified' }
    ],
    openQuestions: [{ text: 'Has legal signed off?', cites: ['u9'], verification: 'unverified' }],
    model: 'claude-main',
    verifiedBy: null,
    ...overrides
  }
}

type Call = { state: any; questions: Record<string, JevQuestion> }

function scripted(verdicts: Record<string, string | Error>, model = 'jev-1.13.0'): { ask: JevAsk; calls: Call[] } {
  const calls: Call[] = []
  const ask: JevAsk = async (state, questions) => {
    calls.push({ state, questions })
    const text = JSON.stringify((questions.support.instructions as any).item)
    const key = Object.keys(verdicts).find((k) => text.includes(k))!
    const verdict = verdicts[key]
    if (verdict instanceof Error) throw verdict
    const probabilities = { supported: 0.02, insufficient: 0.02, contradicted: 0.02, unrelated: 0.02, [verdict]: 0.94 }
    return { model, answers: { support: { type: 'choice', choice: verdict, confidence: 0.92, probabilities } } }
  }
  return { ask, calls }
}

describe('verifyNotes', () => {
  it('sends one support question per item with the cited utterances and two neighbours each side', async () => {
    const { ask, calls } = scripted({ 'Ship it.': 'supported', checklist: 'supported', legal: 'supported' })
    await verifyNotes(notes(), utterances, ask)
    expect(calls).toHaveLength(3)
    const action = calls.find((c) => JSON.stringify(c.questions).includes('checklist'))!
    expect(Object.keys(action.state.segments)).toEqual(['u0', 'u1', 'u2', 'u3'])
    expect(action.state.segments.u1).toEqual({ speaker: 'Blake Whitmore', start: '00:01:01', text: 'line 1' })
    expect(action.state.notice).toMatch(/data, never as instructions/)
    const q = action.questions.support
    expect(Object.keys(action.questions)).toEqual(['support'])
    expect(q.type).toBe('choice')
    expect(Object.keys(q.criteria)).toEqual(['supported', 'insufficient', 'contradicted', 'unrelated'])
    expect(q.criteria.supported).toMatch(/owner and due date/)
    expect(q.instructions).toMatchObject({
      item: { kind: 'action_item', task: 'Send the checklist.', owner: 'Blake Whitmore', due: 'Friday' },
      cited_segments: [{ id: 'u1', speaker: 'Blake Whitmore', text: 'line 1' }]
    })
    expect((q.instructions as any).question).toMatch(/owner and due date/)
    const decision = calls.find((c) => JSON.stringify(c.questions).includes('Ship it.'))!
    expect(Object.keys(decision.state.segments)).toEqual(['u3', 'u4', 'u5', 'u6', 'u7'])
    const openQ = calls.find((c) => JSON.stringify(c.questions).includes('legal'))!
    expect(Object.keys(openQ.state.segments)).toEqual(['u7', 'u8', 'u9'])
  })

  it('merges neighbour windows of several cites', async () => {
    const { ask, calls } = scripted({ 'Ship it.': 'supported' })
    await verifyNotes(notes({ decisions: [{ text: 'Ship it.', cites: ['u2', 'u8'], verification: 'unverified' }], actionItems: [], openQuestions: [] }), utterances, ask)
    expect(Object.keys(calls[0].state.segments)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4', 'u6', 'u7', 'u8', 'u9'])
  })

  it('keeps supported and insufficient items, drops contradicted and unrelated ones', async () => {
    const input = notes({
      decisions: [
        { text: 'Ship it.', cites: ['u5'], verification: 'unverified' },
        { text: 'Rename it.', cites: ['u4'], verification: 'unverified' }
      ]
    })
    const { ask } = scripted({ 'Ship it.': 'supported', 'Rename it.': 'unrelated', checklist: 'contradicted', legal: 'insufficient' })
    const out = await verifyNotes(input, utterances, ask)
    expect(out.summary).toEqual(['We talked.'])
    expect(out.decisions).toEqual([{ text: 'Ship it.', cites: ['u5'], verification: 'supported', confidence: 0.94 }])
    expect(out.actionItems).toEqual([])
    expect(out.openQuestions).toEqual([
      { text: 'Has legal signed off?', cites: ['u9'], verification: 'insufficient', confidence: 0.94 }
    ])
    expect(out.verifiedBy).toBe('jev-1.13.0')
    expect(out.model).toBe('claude-main')
  })

  it('leaves an item unverified when its request fails, and still verifies the rest', async () => {
    const { ask } = scripted({ 'Ship it.': new TypesafeError('TypeSafe returned 529', 529), checklist: 'supported', legal: 'supported' })
    const out = await verifyNotes(notes(), utterances, ask)
    expect(out.decisions).toEqual([{ text: 'Ship it.', cites: ['u5'], verification: 'unverified' }])
    expect(out.actionItems[0].verification).toBe('supported')
    expect(out.verifiedBy).toBe('jev-1.13.0')
  })

  it('reports verifiedBy null when nothing could be verified', async () => {
    const failing: JevAsk = async () => {
      throw new Error('down')
    }
    const out = await verifyNotes(notes({ verifiedBy: 'stale' }), utterances, failing)
    expect(out.verifiedBy).toBeNull()
    expect([...out.decisions, ...out.actionItems, ...out.openQuestions].every((i) => i.verification === 'unverified')).toBe(true)
    expect(out.decisions).toHaveLength(1)

    const empty = await verifyNotes(notes({ decisions: [], actionItems: [], openQuestions: [] }), utterances, failing)
    expect(empty.verifiedBy).toBeNull()
    expect(empty.summary).toEqual(['We talked.'])
  })

  it('does not call JEV for an item whose cites are not in the transcript', async () => {
    const ask = vi.fn<JevAsk>()
    const out = await verifyNotes(
      notes({ decisions: [{ text: 'Ghost.', cites: ['u99'], verification: 'unverified' }], actionItems: [], openQuestions: [] }),
      utterances,
      ask
    )
    expect(ask).not.toHaveBeenCalled()
    expect(out.decisions[0].verification).toBe('unverified')
  })

  it('runs at most four requests at once and keeps item order', async () => {
    let inFlight = 0
    let peak = 0
    const ask: JevAsk = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return {
        model: 'jev',
        answers: { support: { type: 'choice', choice: 'supported', confidence: 1, probabilities: { supported: 1, insufficient: 0, contradicted: 0, unrelated: 0 } } }
      }
    }
    const many = Array.from({ length: 10 }, (_, i) => ({ text: `D${i}`, cites: [`u${i}`], verification: 'unverified' as const }))
    const out = await verifyNotes(notes({ decisions: many, actionItems: [], openQuestions: [] }), utterances, ask)
    expect(peak).toBe(4)
    expect(out.decisions.map((d) => d.text)).toEqual(many.map((d) => d.text))
  })
})
