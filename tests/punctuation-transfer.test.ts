import { describe, expect, it } from 'vitest'
import { borrowPunctuation } from '@shared/punctuation-transfer'

describe('borrowPunctuation', () => {
  it('adds sentence breaks to a run-on while keeping the target words', () => {
    expect(
      borrowPunctuation(
        'so i did 27 PRs with Codex and then i did 18 PRs with Claude Code and it has been going really good',
        'So I did 27 PRs with Codex, and then I did 18 PR with cloud code. And it has been going really good.'
      )
    ).toBe('So I did 27 PRs with Codex, and then I did 18 PRs with Claude Code. And it has been going really good.')
  })

  it('keeps names the target already capitalized', () => {
    expect(borrowPunctuation('Tell Bryan the Vetta build is ready', 'tell brian the beta build is ready.')).toBe(
      'Tell Bryan the Vetta build is ready.'
    )
  })

  it('removes a stray mark the donor does not have', () => {
    expect(borrowPunctuation('We shipped it, today.', 'We shipped it today.')).toBe('We shipped it today.')
  })

  it('leaves the target alone when the donor has nothing to offer', () => {
    expect(borrowPunctuation('Please send the update.', '')).toBe('Please send the update.')
  })

  describe('with substitutions', () => {
    it('also punctuates a word the donor heard differently, one for one', () => {
      expect(
        borrowPunctuation(
          'the only board we check is BROXA we switch next month',
          'The only board we check is brocksa. We switch next month.',
          { substitutions: true }
        )
      ).toBe('The only board we check is BROXA. We switch next month.')
    })

    it('capitalizes a substituted word without taking the donor spelling', () => {
      expect(borrowPunctuation('it is fine zeltra is next', 'It is fine. Zebra is next.', { substitutions: true })).toBe(
        'It is fine. Zeltra is next.'
      )
    })

    it('does not pair gaps of different lengths', () => {
      expect(borrowPunctuation('we send it to hiring at NWG and', 'We send it to hiring at Northwind group. And', { substitutions: true })).toBe(
        'We send it to hiring at NWG And' // no period on NWG: two donor words for one
      )
    })

    it('is off by default', () => {
      expect(borrowPunctuation('it is BROXA we switch', 'It is brocksa. We switch.')).toBe('It is BROXA We switch.')
    })
  })
})
