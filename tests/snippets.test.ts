import { describe, it, expect } from 'vitest'
import { expandSnippet } from '../src/shared/snippets'

const snips = [
  { cue: 'my address', expansion: '123 Main St, Springfield' },
  { cue: 'Scheduling Link', expansion: 'https://example.com/schedule' }
]

describe('expandSnippet', () => {
  it('expands an exact cue', () => {
    expect(expandSnippet('my address', snips)).toBe('123 Main St, Springfield')
  })

  it('ignores case and a trailing period', () => {
    expect(expandSnippet('My address.', snips)).toBe('123 Main St, Springfield')
    expect(expandSnippet('scheduling link', snips)).toBe('https://example.com/schedule')
  })

  it('ignores surrounding whitespace', () => {
    expect(expandSnippet('  my   address  ', snips)).toBe('123 Main St, Springfield')
  })

  it('does not expand a cue inside a sentence', () => {
    expect(expandSnippet('what is my address again', snips)).toBeNull()
  })

  it('returns null for no match or blank input', () => {
    expect(expandSnippet('phone number', snips)).toBeNull()
    expect(expandSnippet('   ', snips)).toBeNull()
  })
})
