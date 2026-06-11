import { describe, it, expect } from 'vitest'
import { wordCount, estimatedSecondsSaved, relativeTime, formatDuration } from '@shared/format'

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
