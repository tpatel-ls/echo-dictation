/** A machine-wide login entry launches Echo for every user with --hidden. Each profile still
 * controls whether that background launch stays alive through its own launchAtLogin setting. */
export function shouldExitHiddenStartup(openedHidden: boolean, launchAtLogin: boolean): boolean {
  return openedHidden && !launchAtLogin
}

export function usesMachineWideStartup(platform: string, packaged: boolean): boolean {
  return packaged && platform === 'win32'
}

export function shouldOpenSecondInstance(argv: string[]): boolean {
  return !argv.includes('--hidden')
}
