import { describe, expect, it } from 'vitest'
import { polishTranscriptStructure } from '@shared/transcript-polish'

describe('mic vs Mike repair', () => {
  it('fixes the homophone in a real mic check', () => {
    expect(polishTranscriptStructure('Hello, hello, Mike Testing, Mike Testing, how is it going?')).toBe(
      'Hello, hello, mic testing, mic testing, how is it going?'
    )
  })

  it('keeps sentence-start capitalization', () => {
    expect(polishTranscriptStructure('Mike check one two.')).toBe('Mic check one two.')
    expect(polishTranscriptStructure('Mike test.')).toBe('Mic test.')
  })

  it('fixes microphone contexts', () => {
    expect(polishTranscriptStructure('Is my mike on?')).toBe('Is my mic on?')
    expect(polishTranscriptStructure('Mute your mike please.')).toBe('Mute your mic please.')
    expect(polishTranscriptStructure('The USB mike is too quiet.')).toBe('The USB mic is too quiet.')
    expect(polishTranscriptStructure('Check the mike volume.')).toBe('Check the mic volume.')
  })

  it('leaves the name Mike alone', () => {
    expect(polishTranscriptStructure('Mike is testing the build.')).toBe('Mike is testing the build.')
    expect(polishTranscriptStructure('Tell Mike to check it.')).toBe('Tell Mike to check it.')
    expect(polishTranscriptStructure('Ask Mike on Slack.')).toBe('Ask Mike on Slack.')
  })
})
