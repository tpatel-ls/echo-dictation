import { describe, it, expect, vi } from 'vitest'
import { pasteText } from '../src/main/insert/paste'

describe('pasteText', () => {
  it('saves prior clipboard, sets text, refocuses, pastes, then restores', async () => {
    const order: string[] = []
    let clip = 'ORIGINAL'
    await pasteText('NEW TEXT', {
      readClipboard: () => {
        order.push('read')
        return clip
      },
      writeClipboard: (t) => {
        order.push(`write:${t}`)
        clip = t
      },
      sendPaste: async () => {
        order.push(`paste(clip=${clip})`)
      },
      refocus: async () => {
        order.push('refocus')
      },
      delay: async () => {
        order.push('delay')
      }
    })
    expect(order).toEqual([
      'read',
      'write:NEW TEXT',
      'refocus',
      'paste(clip=NEW TEXT)',
      'delay',
      'write:ORIGINAL'
    ])
    expect(clip).toBe('ORIGINAL')
  })

  it('pastes the new text while it is on the clipboard, not the old text', async () => {
    let clip = 'OLD'
    let clipboardAtPaste = ''
    await pasteText('HELLO', {
      readClipboard: () => clip,
      writeClipboard: (t) => {
        clip = t
      },
      sendPaste: async () => {
        clipboardAtPaste = clip
      },
      delay: async () => {}
    })
    expect(clipboardAtPaste).toBe('HELLO')
    expect(clip).toBe('OLD') // restored afterward
  })

  it('works without a refocus dep', async () => {
    let clip = 'X'
    const paste = vi.fn(async () => {})
    await pasteText('Y', {
      readClipboard: () => clip,
      writeClipboard: (t) => {
        clip = t
      },
      sendPaste: paste,
      delay: async () => {}
    })
    expect(paste).toHaveBeenCalledOnce()
    expect(clip).toBe('X')
  })
})
