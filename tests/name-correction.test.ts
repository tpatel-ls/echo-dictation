import { describe, it, expect } from 'vitest'
import { correctNames, nameTokens } from '@shared/name-correction'

const NAMES = nameTokens(['Tanay Mehra', 'Darin Kadiro', 'Tanay'])

describe('nameTokens', () => {
  it('splits full names into distinct first and last names of 4+ letters', () => {
    expect(nameTokens(['Tanay Mehra', 'Darin Kadiro', 'Tanay', 'Bo Li'])).toEqual(['Tanay', 'Mehra', 'Darin', 'Kadiro'])
  })
})

describe('correctNames (mishearings of known names)', () => {
  const fix = (text: string): string => correctNames(text, NAMES).text
  it('fixes capitalised near-misses of a participant name', () => {
    expect(fix('Hey Deren, how are you?')).toBe('Hey Darin, how are you?')
    expect(fix('Good to see you Daren. Thanks.')).toBe('Good to see you Darin. Thanks.')
    expect(fix("So it's the two of us. I'm Thane and I run the build.")).toBe("So it's the two of us. I'm Tanay and I run the build.")
    expect(fix("Hi Tani, thanks for joining early")).toBe("Hi Tanay, thanks for joining early")
    expect(fix("Uh sorry Tanya I didn't hear you")).toBe("Uh sorry Tanay I didn't hear you")
    expect(fix('Thank you as well Danay')).toBe('Thank you as well Tanay')
    expect(fix("Tanya's point was fair")).toBe("Tanay's point was fair")
  })

  it('fixes an address-position split like "dare in"', () => {
    expect(fix("It's it's dare in right")).toBe("It's it's Darin right")
  })

  it('reports each fix', () => {
    expect(correctNames('Hey Deren and Thane', NAMES).fixes).toEqual([
      { from: 'Deren', to: 'Darin' },
      { from: 'Thane', to: 'Tanay' }
    ])
  })

  it('leaves ordinary words, other names and lowercase text alone', () => {
    for (const text of [
      'Then we ship it on Tuesday.',
      'Tony said the build was fine.',
      'Tina and Tim joined late.',
      'the dare in this game was fun',
      'a tiny change, then another',
      'Than that, nothing.',
      'We use Datadog and Postgres.',
      'TANAY in capitals stays as written',
      'Tanay and Darin are already right.'
    ]) {
      expect(fix(text)).toBe(text)
    }
  })

  it('fixes a misheard full name, surname included, and takes full names directly (a Slack huddle)', () => {
    const known = ['Tanay', 'Darin Kadiro', 'Blake Whitmore']
    expect(correctNames('Daren uh Daren Kudira uh Daren your your', known)).toEqual({
      text: 'Darin uh Darin Kadiro uh Darin your your',
      fixes: [
        { from: 'Daren', to: 'Darin' },
        { from: 'Daren Kudira', to: 'Darin Kadiro' },
        { from: 'Daren', to: 'Darin' }
      ]
    })
    expect(correctNames('I spoke to Darin Kadira today.', known).text).toBe('I spoke to Darin Kadiro today.')
  })

  it('fixes a surname only right after that person\'s first name', () => {
    const known = ['Darin Kadiro', 'Blake Whitmore']
    for (const text of [
      'Kudira said so.', // a lone surname-like word: first vowel differs, left alone
      'Darin Mehra joined.', // another surname
      'Darin said so, and Blake agreed.', // a lower-case word after the first name
      'Blake Kudira called.', // Kadiro is not Blake's surname
      'Zeltra and BROXA are tools.'
    ]) {
      expect(correctNames(text, known).text).toBe(text)
    }
  })

  it('does nothing without names', () => {
    expect(correctNames('Hey Deren', []).text).toBe('Hey Deren')
  })
})
