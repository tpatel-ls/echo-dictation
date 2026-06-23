import { clipboard } from 'electron'
import { keyboard, Key } from '@nut-tree-fork/nut-js'
import type { PasteDeps } from './paste'
import type { SelectionDeps } from './selection'
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

/** Real selection-probe dependencies: Electron's clipboard + a nut.js Ctrl/⌘+C to copy the
 *  focused app's current selection (see selection.ts for the pure sentinel/poll/restore logic). */
export function realSelectionDeps(): SelectionDeps {
  // ⌘C on macOS, Ctrl+C everywhere else — the same modifier the platform uses for paste.
  const modifier = pasteModifier() === 'super' ? Key.LeftSuper : Key.LeftControl
  return {
    readClipboard: () => clipboard.readText(),
    writeClipboard: (text) => clipboard.writeText(text),
    sendCopy: async () => {
      keyboard.config.autoDelayMs = 0
      await keyboard.pressKey(modifier, Key.C)
      await keyboard.releaseKey(modifier, Key.C)
    },
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
}
