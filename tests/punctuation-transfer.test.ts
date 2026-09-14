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
})
