import { app, systemPreferences, shell, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * macOS privacy onboarding. To dictate into any app, Echo needs three permissions the
 * OS withholds by default:
 *   • Accessibility   — to post the synthetic ⌘V that pastes text
 *   • Input Monitoring — to receive the global hold-to-talk Option key
 *   • Microphone       — to hear you
 * Windows and Linux need none of this (the mic is granted via Chromium's own prompt),
 * so every function here is a no-op off macOS.
 */

export type MicStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

export interface MacPermissions {
  accessibility: boolean
  microphone: MicStatus
}

export function isMac(): boolean {
  return process.platform === 'darwin'
}

/** Read current macOS privacy status. Off macOS, report everything granted. */
export function checkMacPermissions(): MacPermissions {
  if (!isMac()) return { accessibility: true, microphone: 'granted' }
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    microphone: systemPreferences.getMediaAccessStatus('microphone') as MicStatus
  }
}

/**
 * Fire the OS's native permission prompts. `isTrustedAccessibilityClient(true)` shows
 * Apple's Accessibility dialog when not yet trusted; `askForMediaAccess` shows the mic
 * prompt. Input Monitoring is triggered separately by starting the key hook. Never
 * throws — any failure surfaces later in Diagnostics.
 */
export async function primeMacPermissions(): Promise<void> {
  if (!isMac()) return
  try {
    await systemPreferences.askForMediaAccess('microphone')
  } catch {
    /* ignore */
  }
  try {
    systemPreferences.isTrustedAccessibilityClient(true)
  } catch {
    /* ignore */
  }
  try {
    await runHelper('EchoPasteHelper', ['--prompt'])
  } catch {
    /* ignore */
  }
  try {
    await runHelper('EchoKeyHelper', ['--prompt'])
  } catch {
    /* ignore */
  }
  try {
    await runHelper('EchoSpeechHelper', ['--prompt'])
  } catch {
    /* ignore */
  }
}

export async function checkNativeHelper(name: string): Promise<boolean> {
  if (!isMac()) return true
  try {
    return (await runHelper(name, ['--check'])) === 0
  } catch {
    return false
  }
}

export type PrivacyPane = 'Accessibility' | 'ListenEvent' | 'Microphone' | 'SpeechRecognition'

/** Open a specific macOS “Privacy & Security” pane in System Settings. */
export function openPrivacyPane(pane: PrivacyPane): void {
  if (!isMac()) return
  void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`)
}

/** Pure one-line summary of permission state for the Diagnostics page. */
export function permissionSummary(p: MacPermissions): { ok: boolean; detail: string } {
  const ok = p.accessibility && p.microphone === 'granted'
  const detail = `Accessibility: ${p.accessibility ? 'granted' : 'NOT granted'} · Microphone: ${p.microphone}`
  return { ok, detail }
}

/**
 * First-run guide. If Accessibility or Microphone is missing, fire the native prompts
 * and then show one dialog pointing the user at the exact System Settings panes. Gated
 * on the checkable permissions, so it stops nagging once those are granted.
 */
export async function showMacOnboardingIfNeeded(): Promise<void> {
  if (!isMac()) return
  const p = checkMacPermissions()
  const pasteTrusted = await checkNativeHelper('EchoPasteHelper')
  const speechTrusted = await checkNativeHelper('EchoSpeechHelper')
  if (p.accessibility && pasteTrusted && speechTrusted && p.microphone === 'granted') return

  await primeMacPermissions()
  const after = checkMacPermissions()
  if (
    after.accessibility &&
    (await checkNativeHelper('EchoPasteHelper')) &&
    (await checkNativeHelper('EchoSpeechHelper')) &&
    after.microphone === 'granted'
  ) return

  const res = await dialog.showMessageBox({
    type: 'info',
    title: 'Finish setting up Echo',
    message: 'Echo needs three macOS permissions to dictate anywhere',
    detail:
      'Open each in System Settings → Privacy & Security, switch Echo and the Echo helpers on, then quit and ' +
      'reopen Echo from the menu-bar icon (Input Monitoring needs a restart to take effect):\n\n' +
      '•  Accessibility — Echo and EchoPasteHelper paste text into other apps\n' +
      '•  Input Monitoring — EchoKeyHelper detects your hold-to-talk key\n' +
      '•  Microphone — hear you\n' +
      '•  Speech Recognition — EchoSpeechHelper checks Apple Speech as a secondary recognizer\n\n' +
      'Echo lives in the menu bar (top-right), not the Dock.',
    buttons: ['Open Accessibility', 'Open Input Monitoring', 'Open Speech Recognition', 'Later'],
    defaultId: 0,
    cancelId: 3
  })
  if (res.response === 0) openPrivacyPane('Accessibility')
  else if (res.response === 1) openPrivacyPane('ListenEvent')
  else if (res.response === 2) openPrivacyPane('SpeechRecognition')
}

function runHelper(name: string, args: string[]): Promise<number> {
  const helper = nativeHelperPath(name)
  if (!existsSync(helper)) return Promise.resolve(0)
  return new Promise((resolve, reject) => {
    const child = spawn(helper, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

function nativeHelperPath(name: string): string {
  if (app.isPackaged) return join(process.resourcesPath, 'native', name)
  return join(process.cwd(), 'out', 'native', name)
}
