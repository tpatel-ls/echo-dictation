import { describe, it, expect } from 'vitest'
import { applyVoiceCommands } from '../src/shared/voice-commands'

describe('applyVoiceCommands', () => {
  it('turns "new paragraph" into a blank line', () => {
    expect(applyVoiceCommands('Thanks for the update. New paragraph. I will review it tomorrow.')).toBe(
      'Thanks for the update.\n\nI will review it tomorrow.'
    )
  })

  it('turns "leave space" / "leave a space" into a blank line', () => {
    expect(applyVoiceCommands('First point here leave space second point here')).toBe(
      'First point here\n\nSecond point here'
    )
    expect(applyVoiceCommands('Hello team, leave a space, the launch is on Friday.')).toBe(
      'Hello team,\n\nThe launch is on Friday.'
    )
  })

  it('turns "new line" / "next line" into a single line break', () => {
    expect(applyVoiceCommands('Best regards new line Tanay')).toBe('Best regards\nTanay')
    expect(applyVoiceCommands('Item one, next line, item two.')).toBe('Item one,\nItem two.')
  })

  it('handles Whisper punctuating the command itself', () => {
    expect(applyVoiceCommands('Sounds good. New paragraph, let me know if that works.')).toBe(
      'Sounds good.\n\nLet me know if that works.'
    )
  })

  it('is case-insensitive and handles several commands in one dictation', () => {
    expect(
      applyVoiceCommands('Hi Bryan new paragraph the report is ready NEW PARAGRAPH thanks new line Tanay')
    ).toBe('Hi Bryan\n\nThe report is ready\n\nThanks\nTanay')
  })

  it('leaves the phrase literal when it is clearly content ("a new paragraph")', () => {
    expect(applyVoiceCommands('Please add a new paragraph about pricing to the doc.')).toBe(
      'Please add a new paragraph about pricing to the doc.'
    )
    expect(applyVoiceCommands('The new line of products ships in May.')).toBe(
      'The new line of products ships in May.'
    )
  })

  it('trims dangling commas/spaces around the break and capitalizes what follows', () => {
    expect(applyVoiceCommands('okay, new paragraph, so the next thing is testing')).toBe(
      'okay,\n\nSo the next thing is testing'
    )
  })

  it('collapses a command at the very start or end instead of leaving stray breaks', () => {
    expect(applyVoiceCommands('New paragraph. Hello there.')).toBe('Hello there.')
    expect(applyVoiceCommands('Hello there. New paragraph.')).toBe('Hello there.')
  })

  it('passes through text with no commands untouched', () => {
    expect(applyVoiceCommands('Just a normal sentence.')).toBe('Just a normal sentence.')
    expect(applyVoiceCommands('')).toBe('')
  })
})
