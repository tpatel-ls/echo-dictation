import { app, clipboard, shell, systemPreferences } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import type { PasteDeps } from './paste'
import type { SelectionDeps } from './selection'

// Shared backing for both dependency sets — Electron's clipboard and the macOS helper chord — so the
// two real* factories can't drift on clipboard access.
const readClipboard = (): string => clipboard.readText()
const writeClipboard = (text: string): void => clipboard.writeText(text)
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Real paste dependencies backed by Electron's clipboard and the native macOS paste helper. */
export function realPasteDeps(refocus?: () => Promise<void>): PasteDeps {
  return { readClipboard, writeClipboard, sendPaste: sendHelper('paste'), refocus, delay }
}

/** Real selection-probe dependencies: Electron's clipboard + native ⌘C to copy the focused
 *  app's current selection (see selection.ts for the pure sentinel/poll/restore logic). */
export function realSelectionDeps(): SelectionDeps {
  return { readClipboard, writeClipboard, sendCopy: sendHelper('copy'), delay }
}

function sendHelper(action: 'copy' | 'paste'): () => Promise<void> {
  return async () => {
    const helper = nativeHelperPath('EchoPasteHelper')
    if (!existsSync(helper)) throw new Error(`Paste helper is not built at ${helper}`)
    const result = await runHelper(helper, action === 'copy' ? ['--copy'] : [])
    if (result.code === 0) return
    pasteLog(
      `${action} helper failed code=${result.code ?? 'signal'} mainAccessibility=${mainAccessibilityTrusted()} message=${JSON.stringify(result.message)} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`
    )
    if (result.code === 2) {
      try {
        systemPreferences.isTrustedAccessibilityClient(true)
      } catch {
        /* ignore */
      }
      await runHelper(helper, ['--prompt']).catch(() => undefined)
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
      throw new Error(
        'Grant Accessibility to Echo and EchoPasteHelper in System Settings → Privacy & Security → Accessibility, then try again.'
      )
    }
    throw new Error(result.message || `${action} helper exited with code ${result.code}`)
  }
}

function runHelper(
  helper: string,
  args: string[]
): Promise<{ code: number | null; message: string; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      resolve({ code, message: helperMessage(stdout) || stderr.trim(), stdout, stderr })
    })
  })
}

function helperMessage(stdout: string): string {
  const last = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop()
  if (!last) return ''
  try {
    const parsed = JSON.parse(last) as { message?: unknown }
    return typeof parsed.message === 'string' ? parsed.message : ''
  } catch {
    return ''
  }
}

function nativeHelperPath(name: string): string {
  if (app.isPackaged) return join(process.resourcesPath, 'native', name)
  return join(process.cwd(), 'out', 'native', name)
}

function mainAccessibilityTrusted(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return false
  }
}

function pasteLog(message: string): void {
  try {
    const file = join(app.getPath('userData'), 'paste.log')
    if (existsSync(file) && statSync(file).size > 64 * 1024) truncateSync(file, 0)
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* Diagnostics must never affect dictation. */
  }
}
