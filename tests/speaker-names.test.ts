import { describe, it, expect, vi } from 'vitest'
import { parseSpeakerNames, suggestSpeakerNames } from '../src/main/meetings/speaker-names'
import type { NotesUtterance } from '../src/main/meetings/notes'

// The start of a call, after name correction (Tanay is the user; the other is unnamed).
const utterances: NotesUtterance[] = [
  { uid: 'u1', speaker: 'Tanay', startMs: 65_000, text: 'Hey Darin, how are you?' },
  { uid: 'u2', speaker: 'Speaker 1', startMs: 70_000, text: "Hi Tanay, good to see you again" },
  { uid: 'u3', speaker: 'Tanay', startMs: 71_000, text: 'Likewise, thanks for making the time.' },
  { uid: 'u4', speaker: 'Speaker 1', startMs: 77_000, text: 'Nice to meet you.' }
]

const config = { claudeBaseUrl: 'https://proxy.example.com/', claudeModel: 'claude-main' }

function messages(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 })
}

describe('parseSpeakerNames', () => {
  it('keeps a name only for an unnamed speaker, backed by a cited utterance that says it', () => {
    const raw = JSON.stringify({
      speakers: [
        { speaker: 'Speaker 1', name: 'Darin', cites: ['u1'] },
        { speaker: 'Tanay', name: 'Tanay Mehra', cites: ['u2'] }, // already named: ignored
        { speaker: 'Speaker 2', name: 'Blake', cites: ['u1'] }, // no such unnamed speaker
        { speaker: 'Speaker 1', name: 'Darin', cites: ['u9'] } // unknown cite
      ]
    })
    expect(parseSpeakerNames(raw, utterances, ['Speaker 1'])).toEqual([{ speaker: 'Speaker 1', name: 'Darin', cites: ['u1'] }])
  })

  it('rejects a name the cited text does not contain (no guessing)', () => {
    const raw = JSON.stringify({ speakers: [{ speaker: 'Speaker 1', name: 'Alex', cites: ['u1', 'u4'] }] })
    expect(parseSpeakerNames(raw, utterances, ['Speaker 1'])).toEqual([])
  })

  it('reads a cite written as the whole line, and finds the name in a neighbouring utterance', () => {
    // The model cited the reply to "Hey Darin" (u2) rather than the line that says the name (u1).
    const raw = JSON.stringify({
      speakers: [{ speaker: 'Speaker 1', name: 'Darin', cites: ["[u2 00:01:10] Speaker 1: Hi Tanay, good to see you"] }]
    })
    expect(parseSpeakerNames(raw, utterances, ['Speaker 1'])).toEqual([{ speaker: 'Speaker 1', name: 'Darin', cites: ['u1'] }])
  })

  it('tolerates prose and fences around the JSON, and garbage', () => {
    const raw = 'Here you go:\n```json\n{"speakers":[{"speaker":"Speaker 1","name":"Darin","cites":["u1"]}]}\n```'
    expect(parseSpeakerNames(raw, utterances, ['Speaker 1'])).toHaveLength(1)
    expect(parseSpeakerNames('no idea', utterances, ['Speaker 1'])).toEqual([])
  })
})

describe('suggestSpeakerNames', () => {
  it('asks once, with the unnamed labels and the calendar candidates, and never sends names it was not given', async () => {
    const fetch = vi.fn(async () => messages('{"speakers":[{"speaker":"Speaker 1","name":"Darin","cites":["u1"]}]}'))
    const out = await suggestSpeakerNames(utterances, ['Speaker 1'], ['Darin Kadiro'], config, 'key', { fetch: fetch as unknown as typeof globalThis.fetch })
    expect(out).toEqual([{ speaker: 'Speaker 1', name: 'Darin', cites: ['u1'] }])
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.messages[0].content).toContain('Speaker 1')
    expect(body.messages[0].content).toContain('Darin Kadiro')
    expect(body.messages[0].content).toContain('[u1 00:01:05] Tanay: Hey Darin, how are you?')
  })

  it('does not call the model when every speaker is named', async () => {
    const fetch = vi.fn()
    expect(await suggestSpeakerNames(utterances, [], [], config, 'key', { fetch: fetch as unknown as typeof globalThis.fetch })).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns nothing when the proxy fails', async () => {
    const fetch = vi.fn(async () => new Response('down', { status: 503 }))
    expect(await suggestSpeakerNames(utterances, ['Speaker 1'], [], config, 'key', { fetch: fetch as unknown as typeof globalThis.fetch })).toEqual([])
  })
})
