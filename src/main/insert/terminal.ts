// Pure decision: does this window title look like a terminal? Kept free of native imports so it
// unit-tests in isolation. Command Mode probes the selection by simulating Ctrl+C — but in a terminal
// Ctrl+C with no selection is SIGINT and would kill the user's running process, so we skip the probe
// for terminal windows entirely.

const TERMINAL_KEYWORDS = [
  'powershell',
  'command prompt',
  'cmd.exe',
  'terminal', // Windows Terminal, macOS/GNOME Terminal, …
  'iterm',
  'wezterm',
  'mingw', // Git Bash ("MINGW64:/c/…")
  'wsl',
  'conemu',
  'cmder',
  'alacritty'
]

/** True if the focused window title looks like a terminal emulator, where a synthetic Ctrl+C could
 *  interrupt a running process rather than copy. */
export function looksLikeTerminal(title: string): boolean {
  const t = title.toLowerCase()
  return TERMINAL_KEYWORDS.some((k) => t.includes(k))
}
