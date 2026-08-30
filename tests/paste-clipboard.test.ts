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

  it('retries transient Windows input failures and refocuses before every attempt', async () => {
    const order: string[] = []
    let clip = 'OLD'
    let attempts = 0

    await pasteText('DICTATED', {
      readClipboard: () => clip,
      writeClipboard: (text) => {
        clip = text
      },
      refocus: async () => {
        order.push('refocus')
      },
      sendPaste: async () => {
        attempts++
        order.push(`paste:${attempts}`)
        if (attempts < 3) throw new Error('SendInput failed (Windows error 87)')
      },
      delay: async (ms) => {
        order.push(`delay:${ms}`)
      },
      retryDelayMs: 40,
      restoreDelayMs: 120
    })

    expect(order).toEqual([
      'refocus',
      'paste:1',
      'delay:40',
      'refocus',
      'paste:2',
      'delay:40',
      'refocus',
      'paste:3',
      'delay:120'
    ])
    expect(clip).toBe('OLD')
  })

  it('never loses dictated text when Windows blocks every insertion attempt', async () => {
    let clip = 'OLD'
    const paste = vi.fn(async () => {
      throw new Error('SendInput failed (Windows error 5)')
    })

    await expect(
      pasteText('DICTATED', {
        readClipboard: () => clip,
        writeClipboard: (text) => {
          clip = text
        },
        sendPaste: paste,
        delay: async () => {}
      })
    ).rejects.toThrow('Text copied to clipboard')

    expect(paste).toHaveBeenCalledTimes(3)
    expect(clip).toBe('DICTATED')
  })

  it('leaves dictated text on the clipboard when macOS blocks auto-paste', async () => {
    let clip = 'OLD'
    await expect(
      pasteText('DICTATED', {
        readClipboard: () => clip,
        writeClipboard: (t) => {
          clip = t
        },
        sendPaste: async () => {
          throw new Error('Grant Accessibility to EchoPasteHelper')
        },
        delay: async () => {}
      })
    ).rejects.toThrow('Text copied to clipboard')
    expect(clip).toBe('DICTATED')
  })
})
