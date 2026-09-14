/** A machine-wide login entry launches Echo for every user with --hidden. Each profile still
 * controls whether that background launch stays alive through its own launchAtLogin setting. */
export function shouldExitHiddenStartup(openedHidden: boolean, launchAtLogin: boolean): boolean {
  return openedHidden && !launchAtLogin
}

/**
 * Only a copy installed under Program Files came from the machine-wide installer, which owns the
 * all-user HKLM entry. A per-user copy (e.g. %LOCALAPPDATA%\Programs) has no such entry and must
 * register its own login item, or it never starts at sign-in.
 */
export function usesMachineWideStartup(
  platform: string,
  packaged: boolean,
  exePath = '',
  programFilesDirs: string[] = []
): boolean {
  if (!packaged || platform !== 'win32') return false
  const exe = exePath.toLowerCase()
  return programFilesDirs.some((dir) => Boolean(dir) && exe.startsWith(`${dir.toLowerCase().replace(/[\\/]+$/, '')}\\`))
}

export function shouldOpenSecondInstance(argv: string[]): boolean {
  return !argv.includes('--hidden')
}
