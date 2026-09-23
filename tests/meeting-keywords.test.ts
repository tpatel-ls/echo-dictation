import { describe, it, expect } from 'vitest'
import { MAX_MEETING_KEYWORDS, meetingKeywordPrompt, meetingKeywords } from '@shared/meeting-keywords'
import type { DictionaryEntry } from '@shared/types'

const entry = (word: string, times_applied = 0, created_at = 0, misheard: string[] = []): DictionaryEntry => ({
  id: created_at,
  word,
  misheard,
  source: 'manual',
  created_at,
  times_applied
})

const none = { userName: '', participants: [], nameHints: [], people: [], dictionary: [] }

describe('meetingKeywords', () => {
  it('lists this meeting’s people first, then remembered voices, then dictionary words', () => {
    expect(
      meetingKeywords({
        userName: 'Tanay',
        participants: [{ name: 'Darin Kadiro', email: 'a@example.org' }],
        nameHints: ['Blake Whitmore'],
        people: ['Nadia Cole'],
        dictionary: [entry('Zeltra'), entry('BROXA')]
      })
    ).toEqual(['Tanay', 'Darin Kadiro', 'Blake Whitmore', 'Nadia Cole', 'Zeltra', 'BROXA'])
  })

  it('puts the most used, then newest, dictionary words first and never sends aliases', () => {
    const dictionary = [entry('Kestrel', 0, 1), entry('hiring@NWG', 5, 2, ['hiring at NWD']), entry('Zeltra', 0, 3, ['deal'])]
    expect(meetingKeywords({ ...none, dictionary })).toEqual(['hiring@NWG', 'Zeltra', 'Kestrel'])
  })

  it('drops duplicates regardless of case, blanks and placeholder speaker labels', () => {
    expect(
      meetingKeywords({
        ...none,
        userName: ' tanay ',
        participants: [{ name: 'Tanay', email: null }, { name: '  ', email: null }],
        nameHints: ['Speaker 2', 'Darin Kadiro'],
        people: ['darin kadiro'],
        dictionary: [entry('TANAY'), entry(' ')]
      })
    ).toEqual(['tanay', 'Darin Kadiro'])
  })

  it('removes commas inside a keyword, since the prompt is a comma list', () => {
    expect(meetingKeywords({ ...none, nameHints: ['Mehra, Tanay'], dictionary: [entry('Acme,  Inc.')] })).toEqual([
      'Mehra Tanay',
      'Acme Inc.'
    ])
  })

  it('caps the list, keeping the meeting’s own people over dictionary words', () => {
    const dictionary = Array.from({ length: 300 }, (_, i) => entry(`Term${i}`, 300 - i))
    const out = meetingKeywords({ ...none, userName: 'Tanay', dictionary })
    expect(out).toHaveLength(MAX_MEETING_KEYWORDS)
    expect(out[0]).toBe('Tanay')
    expect(out[1]).toBe('Term0')
    expect(meetingKeywords({ ...none, userName: 'Tanay', dictionary }, 3)).toEqual(['Tanay', 'Term0', 'Term1'])
  })

  it('skips absurdly long entries rather than letting one fill the prompt', () => {
    expect(meetingKeywords({ ...none, dictionary: [entry('x'.repeat(80)), entry('Zeltra')] })).toEqual(['Zeltra'])
  })
})

describe('meetingKeywordPrompt', () => {
  it('joins keywords with commas, and is empty for none', () => {
    expect(meetingKeywordPrompt(['Zeltra', 'BROXA', 'hiring@NWG'])).toBe('Zeltra, BROXA, hiring@NWG')
    expect(meetingKeywordPrompt([])).toBe('')
  })
})
