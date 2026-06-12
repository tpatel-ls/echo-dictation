// Pure platform decisions for inserting text. Kept free of native (nut.js) and Electron
// imports so it's unit-testable in isolation — see tests/platform.test.ts.

/** The modifier a platform uses for the "paste" shortcut. */
export type PasteModifier = 'super' | 'control'

/** macOS pastes with ⌘ (Command → nut.js `LeftSuper`); everywhere else with Ctrl. */
export function pasteModifier(platform: NodeJS.Platform = process.platform): PasteModifier {
  return platform === 'darwin' ? 'super' : 'control'
}
