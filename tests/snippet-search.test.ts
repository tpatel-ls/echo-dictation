import { describe, expect, it } from 'vitest'
import { filterSnippets } from '../src/shared/snippet-search'

const snippets = [
  { cue: 'Meeting link', expansion: 'https://meet.example/room' },
  { cue: 'Office address', expansion: '123 Main Street, Chicago' },
  { cue: 'Email signoff', expansion: 'Best,\nTanay' }
]

describe('filterSnippets', () => {
  it('returns the original stable order for a blank query', () => {
    expect(filterSnippets(snippets, '   ')).toEqual(snippets)
  })

  it('matches cue and expansion text case-insensitively', () => {
    expect(filterSnippets(snippets, 'MEETING')).toEqual([snippets[0]])
    expect(filterSnippets(snippets, 'chicago')).toEqual([snippets[1]])
  })

  it('normalizes repeated query whitespace', () => {
    expect(filterSnippets(snippets, 'main   street')).toEqual([snippets[1]])
  })

  it('preserves source order when multiple snippets match', () => {
    expect(filterSnippets(snippets, 'st').map((snippet) => snippet.cue)).toEqual([
      'Office address',
      'Email signoff'
    ])
  })
})
