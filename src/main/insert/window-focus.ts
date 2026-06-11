import { getActiveWindow } from '@nut-tree-fork/nut-js'

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
    const win = await getActiveWindow()
    let title = ''
    try {
      title = await win.title
    } catch {
      /* ignore */
    }
    return {
      title: title || 'Unknown',
      focus: async () => {
        try {
          const w = win as unknown as { focus?: () => Promise<void> }
          if (typeof w.focus === 'function') await w.focus()
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    return { title: 'Unknown', focus: async () => {} }
  }
}
