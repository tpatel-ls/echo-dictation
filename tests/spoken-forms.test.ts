import { describe, expect, it } from 'vitest'
import { normalizeSpokenForms } from '@shared/spoken-forms'

describe('normalizeSpokenForms', () => {
  it('fixes the spelled-out acronyms and number words from a real dictation', () => {
    expect(
      normalizeSpokenForms(
        'I merged the PR and integrated seven P R s and then out of those seven P R\'s we had twenty seven issues.'
      )
    ).toBe("I merged the PR and integrated 7 PRs and then out of those 7 PR's we had 27 issues.")
  })

  it('joins spelled acronyms', () => {
    expect(normalizeSpokenForms('Call the A P I from the U S A office.')).toBe('Call the API from the USA office.')
    expect(normalizeSpokenForms('Ship the M V P.')).toBe('Ship the MVP.')
  })

  it('leaves the words I and A alone', () => {
    expect(normalizeSpokenForms('Plan A I think works.')).toBe('Plan A I think works.')
    expect(normalizeSpokenForms('I will send it.')).toBe('I will send it.')
  })

  it('converts cardinal number words to digits', () => {
    expect(normalizeSpokenForms('We need two hundred and fifty seats.')).toBe('We need 250 seats.')
    expect(normalizeSpokenForms('The budget is twelve thousand four hundred.')).toBe('The budget is 12,400.')
    expect(normalizeSpokenForms('Add twenty-seven rows.')).toBe('Add 27 rows.')
    expect(normalizeSpokenForms('Seven people joined.')).toBe('7 people joined.')
    expect(normalizeSpokenForms('It takes three point five seconds.')).toBe('It takes 3.5 seconds.')
    expect(normalizeSpokenForms('Growth was twenty percent.')).toBe('Growth was 20%.')
  })

  it('reads paired two-digit numbers as a year', () => {
    expect(normalizeSpokenForms('Back in twenty twenty six we launched.')).toBe('Back in 2026 we launched.')
  })

  it('keeps idiomatic uses of one and ordinals as words', () => {
    expect(normalizeSpokenForms('No one knows which one of them is first.')).toBe(
      'No one knows which one of them is first.'
    )
    expect(normalizeSpokenForms('We had a one-on-one.')).toBe('We had a one-on-one.')
    expect(normalizeSpokenForms('One hundred people came.')).toBe('100 people came.')
  })

  it('leaves text without spoken forms untouched', () => {
    const text = 'Please send the updated invoice to Kyle before Friday.\n\nThanks.'
    expect(normalizeSpokenForms(text)).toBe(text)
  })
})
