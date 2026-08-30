// Pure paste orchestration. Native clipboard/keyboard are injected (see paste-deps.ts)
// so the clipboard save/restore logic is unit-testable without a running OS.

export interface PasteDeps {
  readClipboard: () => string
  writeClipboard: (text: string) => void
  sendPaste: () => Promise<void>
  refocus?: () => Promise<void>
  delay: (ms: number) => Promise<void>
  retryDelayMs?: number
  restoreDelayMs?: number
  maxAttempts?: number
}

/**
 * Insert `text` at the current cursor by: snapshotting the clipboard, writing the
 * text, re-focusing the original target window, sending Ctrl+V, then restoring the
 * user's previous clipboard contents.
 */
export async function pasteText(text: string, deps: PasteDeps): Promise<void> {
  const previous = deps.readClipboard()
  deps.writeClipboard(text)

  const maxAttempts = Math.max(1, deps.maxAttempts ?? 3)
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (deps.refocus) await deps.refocus()
      await deps.sendPaste()
      await deps.delay(deps.restoreDelayMs ?? 120)
      deps.writeClipboard(previous)
      return
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) await deps.delay(deps.retryDelayMs ?? 40)
    }
  }

  const detail = lastError instanceof Error ? ` ${lastError.message}` : ''
  throw new Error(
    `Auto-paste failed after ${maxAttempts} attempts. Text copied to clipboard; paste it manually with Ctrl+V or Command+V.${detail}`
  )
}
