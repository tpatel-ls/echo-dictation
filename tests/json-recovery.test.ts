import { describe, expect, it, vi } from 'vitest'
import { readJsonWithRecovery, type JsonRecoveryOperations } from '../src/main/store/json-recovery'

function operations(overrides: Partial<JsonRecoveryOperations> = {}): JsonRecoveryOperations {
  return {
    exists: () => true,
    read: () => '{"enabled":true}',
    rename: vi.fn(),
    now: () => new Date('2026-07-12T23:45:01.123Z'),
    ...overrides
  }
}

describe('readJsonWithRecovery', () => {
  it('returns null when the file does not exist', () => {
    const fs = operations({ exists: () => false })
    expect(readJsonWithRecovery('/data/settings.json', fs)).toBeNull()
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('returns valid JSON without moving the file', () => {
    const fs = operations()
    expect(readJsonWithRecovery('/data/settings.json', fs)).toEqual({ enabled: true })
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('backs up malformed JSON and returns null', () => {
    const fs = operations({ read: () => '{broken' })

    expect(readJsonWithRecovery('/data/settings.json', fs)).toBeNull()
    expect(fs.rename).toHaveBeenCalledWith(
      '/data/settings.json',
      '/data/settings.json.corrupt-20260712T234501123Z'
    )
  })

  it('still recovers when the corrupt file cannot be moved', () => {
    const fs = operations({
      read: () => 'not-json',
      rename: vi.fn(() => { throw new Error('read-only volume') })
    })
    expect(readJsonWithRecovery('/data/settings.json', fs)).toBeNull()
  })

  it('does not move a file that could not be read', () => {
    const fs = operations({ read: () => { throw new Error('permission denied') } })
    expect(readJsonWithRecovery('/data/settings.json', fs)).toBeNull()
    expect(fs.rename).not.toHaveBeenCalled()
  })
})
