import { app, clipboard } from 'electron'
import { transcribe } from './transcription/whisper'
import { cleanup } from './transcription/claude'
import { floatToWav } from '@shared/wav'
import { checkMacPermissions, checkNativeHelper, isMac } from './permissions'
import { checkNativeSpeechStatus } from './transcription/native-speech'
import type { DiagName, DiagResult } from '@shared/types'
import type { SettingsStore } from './store/settings'

function result(name: DiagName, ok: boolean, detail: string, t0: number): DiagResult {
  return { name, ok, detail, ms: Date.now() - t0 }
}

/** Main-process diagnostics. (The `mic` check runs in the dashboard renderer.) */
export async function runDiagnostic(
  name: DiagName,
  settings: SettingsStore,
  hotkeyRunning: boolean
): Promise<DiagResult> {
  const s = settings.getSettings()
  const sec = settings.getSecrets()
  const t0 = Date.now()
  try {
    switch (name) {
      case 'whisper': {
        if (!sec.whisperApiKey) return result(name, false, 'No Whisper API key set.', t0)
        const wav = floatToWav(new Float32Array(Math.round(16000 * 0.3)), 16000)
        const text = await transcribe(wav, s, sec.whisperApiKey)
        return result(name, true, `Reachable. Empty-audio response: "${text.slice(0, 32)}".`, t0)
      }
      case 'claude': {
        if (!sec.claudeApiKey) return result(name, false, 'No Claude API key set.', t0)
        const out = await cleanup('this is a test', s, sec.claudeApiKey)
        return result(name, true, `Reachable. Cleaned sample → "${out.slice(0, 32)}".`, t0)
      }
      case 'paste': {
        const prev = clipboard.readText()
        clipboard.writeText('echo-diagnostic')
        const roundTrip = clipboard.readText() === 'echo-diagnostic'
        clipboard.writeText(prev)
        if (!roundTrip) return result(name, false, 'Clipboard round-trip failed.', t0)
        // On macOS the synthetic paste keystroke needs Accessibility permission.
        if (isMac() && !checkMacPermissions().accessibility) {
          return result(
            name,
            false,
            'Grant Accessibility to Echo in System Settings → Privacy & Security → Accessibility.',
            t0
          )
        }
        if (isMac() && !(await checkNativeHelper('EchoPasteHelper'))) {
          return result(
            name,
            false,
            'Grant Accessibility to EchoPasteHelper in System Settings → Privacy & Security → Accessibility.',
            t0
          )
        }
        const chord = isMac() ? '⌘V' : 'Ctrl+V'
        return result(name, true, `Clipboard OK. ${chord} is sent into the focused field when you dictate.`, t0)
      }
      case 'hotkey': {
        if (!hotkeyRunning) return result(name, false, 'Keyboard hook is not running.', t0)
        const base = `Global keyboard hook running. Trigger: ${s.triggerKey}.`
        // On macOS the hook only receives keys once Input Monitoring is granted.
        const note = isMac() ? ' Requires Input Monitoring permission for EchoKeyHelper (quit & reopen after granting).' : ''
        const speech = isMac() ? await nativeSpeechDiagnostic() : ''
        return result(name, true, base + note + speech, t0)
      }
      case 'mic':
        return result(name, false, 'Mic is tested directly from this window.', t0)
      default:
        return result(name, false, 'Unknown diagnostic.', t0)
    }
  } catch (e) {
    return result(name, false, (e as Error).message, t0)
  }
}

async function nativeSpeechDiagnostic(): Promise<string> {
  const status = await checkNativeSpeechStatus({
    platform: process.platform,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined
  })
  if (!status || (status.type !== 'check' && status.type !== 'ready')) return ' Native speech: helper unavailable.'
  const localeAvailable = status.localeAvailable === undefined ? 'unknown' : status.localeAvailable ? 'available' : 'unavailable'
  return ` Native speech: authorization ${status.authorization}; engine ${status.engine}; en-US ${localeAvailable}.`
}
