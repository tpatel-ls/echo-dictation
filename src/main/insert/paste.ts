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
  try {
    if (deps.refocus) await deps.refocus()
    await deps.sendPaste()
    await deps.delay(deps.restoreDelayMs ?? 120)
    deps.writeClipboard(previous)
  } catch (e) {
    const message = (e as Error)?.message ?? 'Auto-paste failed'
    if (/Accessibility|EchoPasteHelper|helper exited/i.test(message)) {
      throw new Error('Auto-paste blocked. Text copied to clipboard; enable Echo and EchoPasteHelper in Accessibility.')
    }
    throw e
  }
}
