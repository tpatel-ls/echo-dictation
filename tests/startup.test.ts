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

  it('uses only the HKLM startup entry on packaged Windows', () => {
    expect(usesMachineWideStartup('win32', true)).toBe(true)
    expect(usesMachineWideStartup('darwin', true)).toBe(false)
    expect(usesMachineWideStartup('win32', false)).toBe(false)
  })

  it('does not reveal the dashboard for a duplicate hidden launch', () => {
    expect(shouldOpenSecondInstance(['Echo.exe', '--hidden'])).toBe(false)
    expect(shouldOpenSecondInstance(['Echo.exe'])).toBe(true)
  })
})
