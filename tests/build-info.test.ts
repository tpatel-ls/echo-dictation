import { describe, expect, it } from 'vitest'
import { createBuildInfo, formatBuildInfo } from '../src/shared/build-info'

describe('createBuildInfo', () => {
  it('uses stable as the packaged default and development for local builds', () => {
    const base = {
      appVersion: '1.2.3', platform: 'darwin', arch: 'arm64', runtimeVersion: '42.0.0',
      nodeVersion: '22.0.0', osVersion: '25.5.0'
    }
    expect(createBuildInfo({ ...base, packaged: true }).channel).toBe('stable')
    expect(createBuildInfo({ ...base, packaged: false }).channel).toBe('development')
  })

  it('accepts known channels and falls back safely from unknown values', () => {
    const base = {
      appVersion: '1.2.3', platform: 'win32', arch: 'x64', runtimeVersion: '42.0.0',
      nodeVersion: '22.0.0', osVersion: '10.0.26100'
    }
    expect(createBuildInfo({ ...base, packaged: true, channel: 'beta' }).channel).toBe('beta')
    expect(createBuildInfo({ ...base, packaged: true, channel: 'private' }).channel).toBe('stable')
  })

  it('formats a stable compact build label', () => {
    const info = createBuildInfo({
      appVersion: '1.2.3',
      platform: 'darwin',
      arch: 'arm64',
      runtimeVersion: '42.0.0',
      nodeVersion: '22.0.0',
      osVersion: '25.5.0',
      packaged: true
    })
    expect(formatBuildInfo(info)).toBe(
      'Echo 1.2.3 · darwin 25.5.0 arm64 · Electron 42.0.0 / Node 22.0.0 · stable'
    )
  })
})
