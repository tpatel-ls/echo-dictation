// Pure paste orchestration. Native clipboard/keyboard are injected (see paste-deps.ts)
// so the clipboard save/restore logic is unit-testable without a running OS.

export interface PasteDeps {
  readClipboard: () => string
  writeClipboard: (text: string) => void
  sendPaste: () => Promise<void>
  refocus?: () => Promise<void>
  delay: (ms: number) => Promise<void>
  restoreDelayMs?: number
}

/**
 * Insert `text` at the current cursor by: snapshotting the clipboard, writing the
 * text, re-focusing the original target window, sending Ctrl+V, then restoring the
 * user's previous clipboard contents.
 */
export async function pasteText(text: string, deps: PasteDeps): Promise<void> {
  const previous = deps.readClipboard()
  deps.writeClipboard(text)
  if (deps.refocus) await deps.refocus()
  await deps.sendPaste()
  await deps.delay(deps.restoreDelayMs ?? 120)
  deps.writeClipboard(previous)
}
