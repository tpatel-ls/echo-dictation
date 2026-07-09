import type { OSPlatform, TriggerKey } from './types'

/** Human label for a trigger key, e.g. for the tray menu and Settings. */
export function triggerLabel(key: TriggerKey): string {
  switch (key) {
    case 'RightControl':
      return 'Right Ctrl'
    case 'LeftControl':
      return 'Left Ctrl'
    case 'RightCommand':
      return 'Right ⌘'
    case 'LeftCommand':
      return 'Left ⌘'
    case 'EitherOption':
      return 'Left or Right ⌥'
    case 'LeftOption':
      return 'Left ⌥'
    case 'RightOption':
      return 'Right ⌥'
    case 'CapsLock':
      return 'Caps Lock'
    case 'F8':
      return 'F8'
  }
}

/**
 * The trigger keys worth offering on a given platform, in display order. macOS
 * keyboards have no Right Ctrl, so the ⌘/⌥ keys lead there; on Windows/Linux the
 * Ctrl keys lead and the Mac-only modifiers are hidden.
 */
export function triggerOptions(platform: OSPlatform): TriggerKey[] {
  if (platform === 'darwin') {
    return ['EitherOption', 'LeftOption', 'RightOption', 'RightCommand', 'LeftCommand', 'CapsLock', 'F8']
  }
  return ['RightControl', 'LeftControl', 'CapsLock', 'F8']
}

/** The sensible default trigger for a fresh install on this platform. */
export function defaultTriggerKey(platform: OSPlatform): TriggerKey {
  return platform === 'darwin' ? 'EitherOption' : 'RightControl'
}
