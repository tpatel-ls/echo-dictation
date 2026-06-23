import { clipboard } from 'electron'
import { keyboard, Key } from '@nut-tree-fork/nut-js'
import type { PasteDeps } from './paste'
import type { SelectionDeps } from './selection'
import { pasteModifier } from './platform'

// Shared backing for both dependency sets — Electron's clipboard and a nut.js modifier-chord — so the
// two real* factories can't drift on clipboard access or the platform modifier.
const readClipboard = (): string => clipboard.readText()
const writeClipboard = (text: string): void => clipboard.writeText(text)
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Press the platform's paste/copy modifier (⌘ on macOS, Ctrl elsewhere) together with `key`. */
function sendChord(key: Key): () => Promise<void> {
  const modifier = pasteModifier() === 'super' ? Key.LeftSuper : Key.LeftControl
  return async () => {
    keyboard.config.autoDelayMs = 0
    await keyboard.pressKey(modifier, key)
    await keyboard.releaseKey(modifier, key)
  }
}

/** Real paste dependencies backed by Electron's clipboard and nut.js keystrokes. */
export function realPasteDeps(refocus?: () => Promise<void>): PasteDeps {
  return { readClipboard, writeClipboard, sendPaste: sendChord(Key.V), refocus, delay }
}

/** Real selection-probe dependencies: Electron's clipboard + a nut.js Ctrl/⌘+C to copy the focused
 *  app's current selection (see selection.ts for the pure sentinel/poll/restore logic). */
export function realSelectionDeps(): SelectionDeps {
  return { readClipboard, writeClipboard, sendCopy: sendChord(Key.C), delay }
}
