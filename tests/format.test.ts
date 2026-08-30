import { describe, it, expect } from 'vitest'
import { wordCount, estimatedSecondsSaved, relativeTime, formatDuration, needsAiCleanup } from '@shared/format'

describe('wordCount', () => {
  it('counts words, collapsing whitespace', () => {
    expect(wordCount('hello world')).toBe(2)
    expect(wordCount('  one   two  three ')).toBe(3)
    expect(wordCount('')).toBe(0)
    expect(wordCount('   ')).toBe(0)
  })
})

describe('estimatedSecondsSaved', () => {
  it('estimates typing time at 40 wpm', () => {
    expect(estimatedSecondsSaved(40)).toBe(60)
    expect(estimatedSecondsSaved(0)).toBe(0)
    expect(estimatedSecondsSaved(20)).toBe(30)
  })
})

describe('formatDuration', () => {
  it('formats seconds, minutes, hours', () => {
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(120)).toBe('2m')
    expect(formatDuration(3660)).toBe('1h 1m')
  })
})

describe('relativeTime', () => {
  const now = 1_000_000_000_000
  it('formats into buckets', () => {
    expect(relativeTime(now, now)).toBe('just now')
    expect(relativeTime(now - 30_000, now)).toBe('just now')
    expect(relativeTime(now - 120_000, now)).toBe('2m ago')
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe('2h ago')
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3d ago')
    expect(relativeTime(now - 14 * 86_400_000, now)).toBe('2w ago')
  })
})

describe('needsAiCleanup', () => {
  it('skips the AI pass for short dictations Whisper already punctuated cleanly', () => {
    expect(needsAiCleanup('Sounds good, see you tomorrow.')).toBe(false)
    expect(needsAiCleanup('On my way!')).toBe(false)
    expect(needsAiCleanup('Can you send me the report?')).toBe(false)
  })

  it('cleans anything with fillers, stutters, or missing punctuation', () => {
    expect(needsAiCleanup('um sounds good see you tomorrow')).toBe(true)
    expect(needsAiCleanup('Sounds good, uh, see you tomorrow.')).toBe(true)
    expect(needsAiCleanup('Sounds good see you tomorrow')).toBe(true) // no terminal punctuation
    expect(needsAiCleanup('The the report is ready.')).toBe(true) // stutter
  })

  it('cleans run-on long text, multi-line text, or text with meta directions', () => {
    expect(
      needsAiCleanup(
        'This is a much longer dictation that keeps going through the first topic and then the second topic and then more implementation detail and then another decision and then follow-up work and several owners and deadlines without any useful sentence break until the very end.'
      )
    ).toBe(true)
    expect(needsAiCleanup('First line.\nSecond line.')).toBe(false)
    expect(needsAiCleanup('Write an email to Bryan.')).toBe(true)
    expect(needsAiCleanup('Scratch that, use Thursday.')).toBe(true)
    expect(needsAiCleanup('Send it Tuesday, no wait, Wednesday.')).toBe(true)
    expect(needsAiCleanup('Use Tuesday, I mean Wednesday.')).toBe(true)
    expect(needsAiCleanup('Actually, change it to Wednesday.')).toBe(true)
  })

  it('skips AI cleanup for longer text that ASR already punctuated into clear sentences', () => {
    expect(
      needsAiCleanup(
        'We need plantain chips. Then create GitHub issues, several tickets, and detailed specifications. Implement them using MCP skills and subagents.'
      )
    ).toBe(false)
  })

  it('cleans empty-ish input defensively', () => {
    expect(needsAiCleanup('')).toBe(true)
  })
})
