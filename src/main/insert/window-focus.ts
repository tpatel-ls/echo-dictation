import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface WindowSnapshot {
  title: string
  focus: () => Promise<void>
}

/**
 * Capture the currently-focused window so we can (a) record its title as the
 * transcript's app context and (b) re-focus it before pasting. All best-effort:
 * failures degrade to a no-op rather than breaking dictation.
 */
export async function snapshotForegroundWindow(): Promise<WindowSnapshot> {
  try {
    const { stdout } = await execFileAsync('osascript', [
      '-e',
      [
        'tell application "System Events"',
        'set frontApp to first application process whose frontmost is true',
        'set appName to name of frontApp',
        'set windowTitle to ""',
        'try',
        'set windowTitle to name of front window of frontApp',
        'end try',
        'return appName & "\n" & windowTitle',
        'end tell'
      ].join('\n')
    ])
    const [appName = 'Unknown', title = ''] = stdout.trim().split(/\r?\n/)
    return {
      title: title ? `${appName} — ${title}` : appName,
      focus: async () => {
        try {
          await execFileAsync('osascript', ['-e', `tell application ${JSON.stringify(appName)} to activate`])
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    return { title: 'Unknown', focus: async () => {} }
  }
}
