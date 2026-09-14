import { describe, expect, it } from 'vitest'
import {
  shouldExitHiddenStartup,
  shouldOpenSecondInstance,
  usesMachineWideStartup
} from '../src/main/startup'

describe('hidden startup', () => {
  it('lets each user disable machine-wide hidden startup', () => {
    expect(shouldExitHiddenStartup(true, false)).toBe(true)
    expect(shouldExitHiddenStartup(true, true)).toBe(false)
    expect(shouldExitHiddenStartup(false, false)).toBe(false)
  })

  it('uses only the HKLM startup entry for a machine-wide Windows install', () => {
    const programFiles = ['C:\\Program Files', 'C:\\Program Files (x86)']
    expect(usesMachineWideStartup('win32', true, 'C:\\Program Files\\Echo\\Echo.exe', programFiles)).toBe(true)
    expect(usesMachineWideStartup('darwin', true, '/Applications/Echo.app', programFiles)).toBe(false)
    expect(usesMachineWideStartup('win32', false, 'C:\\Program Files\\Echo\\Echo.exe', programFiles)).toBe(false)
  })

  it('registers its own login item for a per-user Windows install', () => {
    const programFiles = ['C:\\Program Files', 'C:\\Program Files (x86)']
    expect(
      usesMachineWideStartup('win32', true, 'C:\\Users\\Tanay\\AppData\\Local\\Programs\\Echo\\Echo.exe', programFiles)
    ).toBe(false)
    expect(usesMachineWideStartup('win32', true, 'C:\\Program Files Extra\\Echo.exe', programFiles)).toBe(false)
  })

  it('does not reveal the dashboard for a duplicate hidden launch', () => {
    expect(shouldOpenSecondInstance(['Echo.exe', '--hidden'])).toBe(false)
    expect(shouldOpenSecondInstance(['Echo.exe'])).toBe(true)
  })
})
