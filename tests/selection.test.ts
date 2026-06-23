import { describe, it, expect } from 'vitest'
import { captureSelection } from '../src/main/insert/selection'

// A fake clipboard whose `sendCopy` models the OS overwriting it with the focused app's selection
// (or doing nothing, when there is no selection). `delay` is a no-op so tests don't really wait.
function harness(sendCopy: (set: (v: string) => void) => void, prior = 'ORIGINAL') {
  let clip = prior
  const writes: string[] = []
  const deps = {
    readClipboard: () => clip,
    writeClipboard: (t: string) => {
      writes.push(t)
      clip = t
    },
    sendCopy: async () => sendCopy((v) => (clip = v)),
    delay: async () => {}
  }
  return { deps, clip: () => clip, writes }
}

describe('captureSelection', () => {
  it('returns the selection when Ctrl+C replaces the sentinel', async () => {
    const h = harness((set) => set('SELECTED TEXT'))
    const out = await captureSelection(h.deps)
    expect(out).toBe('SELECTED TEXT')
  })

  it('restores the prior clipboard after capturing a selection', async () => {
    const h = harness((set) => set('SELECTED TEXT'))
    await captureSelection(h.deps)
    expect(h.clip()).toBe('ORIGINAL')
  })

  it('returns null when nothing is selected (clipboard stays the sentinel)', async () => {
    const h = harness(() => {}) // Ctrl+C is a no-op: no selection
    const out = await captureSelection({ ...h.deps, maxWaitMs: 100, pollIntervalMs: 25 })
    expect(out).toBeNull()
    expect(h.clip()).toBe('ORIGINAL') // still restored
  })

  it('detects a selection that equals the prior clipboard (sentinel disambiguates)', async () => {
    // The selection happens to be identical to what was already on the clipboard.
    const h = harness((set) => set('ORIGINAL'), 'ORIGINAL')
    const out = await captureSelection(h.deps)
    expect(out).toBe('ORIGINAL')
  })

  it('polls until a slow app finishes the copy', async () => {
    let clip = 'ORIGINAL'
    let polls = 0
    const out = await captureSelection({
      readClipboard: () => clip,
      writeClipboard: (t: string) => (clip = t),
      sendCopy: async () => {}, // copy lands later
      delay: async () => {
        polls++
        if (polls === 3) clip = 'LATE SELECTION'
      },
      pollIntervalMs: 25,
      maxWaitMs: 250
    })
    expect(out).toBe('LATE SELECTION')
  })

  it('treats an empty copy result as no selection', async () => {
    const h = harness((set) => set('')) // some apps copy an empty string
    const out = await captureSelection(h.deps)
    expect(out).toBeNull()
    expect(h.clip()).toBe('ORIGINAL')
  })

  it('never leaves the sentinel on the clipboard', async () => {
    const h = harness(() => {}) // no selection — worst case for a leaked sentinel
    await captureSelection(h.deps)
    expect(h.clip()).toBe('ORIGINAL')
  })
})
