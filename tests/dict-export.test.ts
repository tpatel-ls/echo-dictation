import { describe, it, expect } from 'vitest'
import { parseDictionaryImport, serializeDictionary } from '../src/shared/dict-export'
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

describe('parseDictionaryImport', () => {
  it('accepts the portable versioned export and normalizes valid entries', () => {
    const parsed = parseDictionaryImport(JSON.stringify({
      version: 1,
      entries: [
        { word: '  GitHub  ', misheard: ['git hub', ''], source: 'learned' },
        { word: 'Kubernetes', misheard: ['kubernetis'] }
      ],
      prompt: 'ignored'
    }))

    expect(parsed).toEqual({
      entries: [
        { word: 'GitHub', misheard: ['git hub'], source: 'learned' },
        { word: 'Kubernetes', misheard: ['kubernetis'], source: 'manual' }
      ],
      skipped: 0
    })
  })

  it('skips malformed and oversized entries without rejecting the whole import', () => {
    const parsed = parseDictionaryImport(JSON.stringify({
      version: 1,
      entries: [
        null,
        { word: '', misheard: [] },
        { word: 'Valid', misheard: ['alias', 3] },
        { word: 'x'.repeat(201), misheard: [] }
      ]
    }))
    expect(parsed).toEqual({ entries: [], skipped: 4 })
  })

  it('rejects invalid JSON and unsupported export versions', () => {
    expect(() => parseDictionaryImport('not json')).toThrow(/valid JSON/)
    expect(() => parseDictionaryImport('{"version":2,"entries":[]}')).toThrow(/version/)
  })
})
