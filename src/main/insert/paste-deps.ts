import { clipboard } from 'electron'
import { keyboard, Key } from '@nut-tree-fork/nut-js'
import type { PasteDeps } from './paste'

/** Real paste dependencies backed by Electron's clipboard and nut.js keystrokes. */
export function realPasteDeps(refocus?: () => Promise<void>): PasteDeps {
  return {
    readClipboard: () => clipboard.readText(),
    writeClipboard: (text) => clipboard.writeText(text),
    sendPaste: async () => {
      keyboard.config.autoDelayMs = 0
      await keyboard.pressKey(Key.LeftControl, Key.V)
      await keyboard.releaseKey(Key.LeftControl, Key.V)
    },
    refocus,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
}
