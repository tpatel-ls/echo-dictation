import { clipboard } from 'electron'
import { transcribe } from './transcription/whisper'
import { cleanup } from './transcription/claude'
import { floatToWav } from '@shared/wav'
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
        return roundTrip
          ? result(name, true, 'Clipboard read/write OK. Ctrl+V is sent into the focused field when you dictate.', t0)
          : result(name, false, 'Clipboard round-trip failed.', t0)
      }
      case 'hotkey':
        return hotkeyRunning
          ? result(name, true, `Global keyboard hook running. Trigger: ${s.triggerKey}.`, t0)
          : result(name, false, 'Keyboard hook is not running.', t0)
      case 'mic':
        return result(name, false, 'Mic is tested directly from this window.', t0)
      default:
        return result(name, false, 'Unknown diagnostic.', t0)
    }
  } catch (e) {
    return result(name, false, (e as Error).message, t0)
  }
}
