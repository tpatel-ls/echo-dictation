import { describe, it, expect } from 'vitest'
import { applyDictionary, buildBiasPrompt, extractCorrections } from '@shared/dictionary'
import type { DictionaryEntry } from '@shared/types'

let nextId = 1
function entry(word: string, misheard: string[] = [], overrides: Partial<DictionaryEntry> = {}): DictionaryEntry {
  return {
    id: nextId++,
    word,
    misheard,
    source: 'manual',
    created_at: 1000,
    times_applied: 0,
    ...overrides
  }
}

describe('applyDictionary', () => {
  it('replaces a misheard word with the canonical spelling', () => {
    const e = entry('Bryan', ['Brian'])
    const r = applyDictionary('I saw Brian today', [e])
    expect(r.text).toBe('I saw Bryan today')
    expect(r.appliedIds).toEqual([e.id])
  })

  it('matches aliases case-insensitively and outputs canonical casing', () => {
    const e = entry('Bryan', ['Brian'])
    expect(applyDictionary('brian said hi', [e]).text).toBe('Bryan said hi')
  })

  it('respects word boundaries — no partial-word replacement', () => {
    const e = entry('Bryan', ['Brian'])
    const r = applyDictionary('Brianna called Brian', [e])
    expect(r.text).toBe('Brianna called Bryan')
    expect(r.appliedIds).toEqual([e.id])
  })

  it('replaces next to punctuation and inside possessives', () => {
    const e = entry('Bryan', ['Brian'])
    expect(applyDictionary("Brian, take Brian's keys.", [e]).text).toBe("Bryan, take Bryan's keys.")
  })

  it('handles multi-word aliases with flexible whitespace', () => {
    const e = entry('Wispr Flow', ['wisp or flow'])
    expect(applyDictionary('I like wisp  or flow a lot', [e]).text).toBe('I like Wispr Flow a lot')
  })

  it('prefers longer aliases over shorter overlapping ones', () => {
    const mini = entry('Mac Mini', ['mac mini'])
    const mac = entry('Mac', ['mac'])
    expect(applyDictionary('my mac mini is fast', [mini, mac]).text).toBe('my Mac Mini is fast')
  })

  it('fixes wrong casing of the canonical word itself', () => {
    const e = entry('GitHub', [])
    const r = applyDictionary('i pushed to github', [e])
    expect(r.text).toBe('i pushed to GitHub')
    expect(r.appliedIds).toEqual([e.id])
  })

  it('does not count already-correct text as applied', () => {
    const e = entry('GitHub', ['github'])
    const r = applyDictionary('GitHub rocks', [e])
    expect(r.text).toBe('GitHub rocks')
    expect(r.appliedIds).toEqual([])
  })

  it('is idempotent', () => {
    const e = entry('Bryan', ['Brian'])
    const once = applyDictionary('ping Brian now', [e])
    const twice = applyDictionary(once.text, [e])
    expect(twice.text).toBe(once.text)
    expect(twice.appliedIds).toEqual([])
  })

  it('applies multiple entries in one pass', () => {
    const a = entry('Bryan', ['Brian'])
    const b = entry('Tanay', ['Tanya'])
    const r = applyDictionary('Brian met Tanya', [a, b])
    expect(r.text).toBe('Bryan met Tanay')
    expect(r.appliedIds.sort()).toEqual([a.id, b.id].sort())
  })

  it('escapes regex metacharacters in aliases', () => {
    const e = entry('Node.js', ['node.js'])
    const r = applyDictionary('i love nodeXjs and node.js', [e])
    expect(r.text).toBe('i love nodeXjs and Node.js')
  })

  it('returns text unchanged for an empty dictionary', () => {
    const r = applyDictionary('nothing to do', [])
    expect(r.text).toBe('nothing to do')
    expect(r.appliedIds).toEqual([])
  })
})

describe('buildBiasPrompt', () => {
  it('joins canonical words only — never aliases', () => {
    const out = buildBiasPrompt([entry('Bryan', ['Brian']), entry('Tanay', ['Tanya'])])
    expect(out).toBe('Bryan, Tanay')
  })

  it('orders by times_applied, then most recent first', () => {
    const a = entry('Alpha', [], { times_applied: 1, created_at: 100 })
    const b = entry('Beta', [], { times_applied: 5, created_at: 50 })
    const c = entry('Gamma', [], { times_applied: 1, created_at: 200 })
    expect(buildBiasPrompt([a, b, c])).toBe('Beta, Gamma, Alpha')
  })

  it('truncates to the character budget without cutting words', () => {
    const words = [entry('Alexander'), entry('Bartholomew'), entry('Christopher')]
    const out = buildBiasPrompt(words, 25)
    expect(out).toBe('Alexander, Bartholomew')
    expect(out.length).toBeLessThanOrEqual(25)
  })

  it('returns empty string for an empty dictionary', () => {
    expect(buildBiasPrompt([])).toBe('')
  })
})

describe('extractCorrections', () => {
  it('finds a single word substitution', () => {
    const c = extractCorrections('Email Brian about the demo', 'Email Bryan about the demo')
    expect(c).toEqual([{ from: 'Brian', to: 'Bryan' }])
  })

  it('finds multiple substitutions', () => {
    const c = extractCorrections('Brian met Tanya yesterday', 'Bryan met Tanay yesterday')
    expect(c).toEqual([
      { from: 'Brian', to: 'Bryan' },
      { from: 'Tanya', to: 'Tanay' }
    ])
  })

  it('strips surrounding punctuation from learned pairs', () => {
    const c = extractCorrections('I saw brian.', 'I saw bryan.')
    expect(c).toEqual([{ from: 'brian', to: 'bryan' }])
  })

  it('ignores punctuation-only edits', () => {
    expect(extractCorrections('hello world', 'hello, world.')).toEqual([])
  })

  it('ignores sentence-case-only changes', () => {
    expect(extractCorrections('the meeting went well', 'The meeting went well.')).toEqual([])
  })

  it('keeps internal-casing corrections like github → GitHub', () => {
    const c = extractCorrections('i pushed to github', 'i pushed to GitHub')
    expect(c).toEqual([{ from: 'github', to: 'GitHub' }])
  })

  it('ignores pure insertions', () => {
    expect(extractCorrections('call mom', 'call mom tomorrow')).toEqual([])
  })

  it('ignores pure deletions', () => {
    expect(extractCorrections('call mom right now', 'call mom')).toEqual([])
  })

  it('collapses adjacent changes into a phrase correction', () => {
    const c = extractCorrections('wisp or flow is great', 'Wispr Flow is great')
    expect(c).toEqual([{ from: 'wisp or flow', to: 'Wispr Flow' }])
  })

  it('skips substitutions longer than three words on either side', () => {
    const c = extractCorrections(
      'send the report to the whole team by friday',
      'send the summary of quarterly results everyone needs by friday'
    )
    expect(c).toEqual([])
  })

  it('learns nothing when most of the text was rewritten', () => {
    const before = 'i think we should meet at noon to discuss the plan'
    const after = 'lunch works better for everyone so let us sync then instead'
    expect(extractCorrections(before, after)).toEqual([])
  })

  it('ignores pure number swaps', () => {
    expect(extractCorrections('meet at 4 pm', 'meet at 5 pm')).toEqual([])
  })

  it('handles empty inputs', () => {
    expect(extractCorrections('', '')).toEqual([])
    expect(extractCorrections('hi', '')).toEqual([])
    expect(extractCorrections('', 'hi')).toEqual([])
  })
})
