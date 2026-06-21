import { describe, it, expect } from 'vitest'
import { shouldApply, advanceCursor, type SyncMeta } from '@shared/sync'

function meta(updatedAt: number, deleted = false): SyncMeta {
  return { uuid: 'a', updatedAt, deleted }
}

describe('shouldApply (last-write-wins merge decision)', () => {
  it('applies an incoming record when there is no local copy', () => {
    expect(shouldApply(null, meta(100))).toBe(true)
  })

  it('applies when the incoming record is strictly newer', () => {
    expect(shouldApply(meta(100), meta(101))).toBe(true)
  })

  it('skips when the incoming record is older', () => {
    expect(shouldApply(meta(200), meta(199))).toBe(false)
  })

  it('skips when timestamps are equal (idempotent re-pull)', () => {
    expect(shouldApply(meta(150), meta(150))).toBe(false)
  })

  it('lets a newer tombstone delete an older live record', () => {
    const local = meta(100, false)
    const incomingDelete = meta(101, true)
    expect(shouldApply(local, incomingDelete)).toBe(true)
  })

  it('lets a newer edit win over an older tombstone (un-deletes)', () => {
    const localTombstone = meta(100, true)
    const incomingEdit = meta(101, false)
    expect(shouldApply(localTombstone, incomingEdit)).toBe(true)
  })
})

describe('advanceCursor', () => {
  it('keeps the current cursor when the batch is empty', () => {
    expect(advanceCursor(7, [])).toBe(7)
  })

  it('advances to the highest seq in the batch', () => {
    expect(advanceCursor(7, [{ seq: 8 }, { seq: 10 }, { seq: 9 }])).toBe(10)
  })

  it('never moves the cursor backwards', () => {
    expect(advanceCursor(20, [{ seq: 8 }, { seq: 12 }])).toBe(20)
  })
})
