import { describe, it, expect } from 'vitest'
import { serializeDictionary } from '../src/shared/dict-export'
import type { DictionaryEntry } from '@shared/types'

function entry(over: Partial<DictionaryEntry> = {}): DictionaryEntry {
  return {
    id: 1,
    word: 'Bryan',
    misheard: ['Brian'],
    source: 'learned',
    created_at: 0,
    times_applied: 3,
    ...over
  }
}

describe('serializeDictionary', () => {
  it('keeps only portable fields (word, misheard, source)', () => {
    const out = serializeDictionary([entry()])
    expect(out.version).toBe(1)
    expect(out.entries).toEqual([{ word: 'Bryan', misheard: ['Brian'], source: 'learned' }])
    // id / created_at / times_applied are local-only and must not leak into the export.
    expect(Object.keys(out.entries[0])).toEqual(['word', 'misheard', 'source'])
  })

  it('includes the Whisper bias prompt with the canonical words', () => {
    const out = serializeDictionary([
      entry({ id: 1, word: 'Bryan', misheard: ['Brian'] }),
      entry({ id: 2, word: 'Kubernetes', misheard: ['kubernetis'], source: 'manual' })
    ])
    expect(out.prompt).toContain('Bryan')
    expect(out.prompt).toContain('Kubernetes')
  })

  it('handles an empty dictionary', () => {
    const out = serializeDictionary([])
    expect(out.entries).toEqual([])
    expect(out.prompt).toBe('')
  })
})
