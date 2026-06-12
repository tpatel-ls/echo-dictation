import { clipboard } from 'electron'
import { keyboard, Key } from '@nut-tree-fork/nut-js'
import type { PasteDeps } from './paste'
import { pasteModifier } from './platform'

/** Real paste dependencies backed by Electron's clipboard and nut.js keystrokes. */
export function realPasteDeps(refocus?: () => Promise<void>): PasteDeps {
  // ⌘V on macOS, Ctrl+V everywhere else (see platform.ts for the pure decision).
  const modifier = pasteModifier() === 'super' ? Key.LeftSuper : Key.LeftControl
  return {
    readClipboard: () => clipboard.readText(),
    writeClipboard: (text) => clipboard.writeText(text),
    sendPaste: async () => {
      keyboard.config.autoDelayMs = 0
      await keyboard.pressKey(modifier, Key.V)
      await keyboard.releaseKey(modifier, Key.V)
    },
    refocus,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
}
