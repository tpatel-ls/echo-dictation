import { describe, expect, it } from 'vitest'
import {
  classifyArtifact,
  validateArtifactSet,
  type ArtifactRecord,
} from '@shared/release-artifacts'

function validRecords(): ArtifactRecord[] {
  return [
    { path: 'dist/Echo-0.1.0-setup.exe', fileOutput: 'PE32 executable Nullsoft Installer' },
    { path: 'dist/win-unpacked/Echo.exe', fileOutput: 'PE32+ executable x86-64' },
    { path: 'dist/win-unpacked/resources/native/EchoKeyHelper.exe', fileOutput: 'PE32+ executable x86-64' },
    { path: 'dist/win-unpacked/resources/native/EchoPasteHelper.exe', fileOutput: 'PE32+ executable x86-64' },
    { path: 'dist/win-unpacked/resources/native/EchoSpeechHelper.exe', fileOutput: 'PE32+ executable x86-64' },
    {
      path: 'dist/mac-arm64/Echo.app',
      fileOutput: 'directory',
      executableFileOutput: 'Mach-O 64-bit executable arm64',
      helperFileOutputs: [
        'Mach-O 64-bit executable arm64',
        'Mach-O 64-bit executable arm64',
        'Mach-O 64-bit executable arm64'
      ],
      signatureValid: true
    },
    { path: 'dist/Echo-0.1.0-arm64.dmg', fileOutput: 'zlib compressed data' },
    { path: 'dist/Echo-0.1.0-arm64-mac.zip', fileOutput: 'Zip archive data' },
    { path: 'android/app/build/outputs/apk/debug/app-debug.apk', fileOutput: 'Zip archive data' },
  ]
}

describe('release artifact verification', () => {
  it('classifies supported artifact paths', () => {
    expect(classifyArtifact('dist/Echo-0.1.0-setup.exe')).toBe('windows-installer')
    expect(classifyArtifact('dist/win-unpacked/Echo.exe')).toBe('windows-runtime')
    expect(classifyArtifact('dist/mac-arm64/Echo.app')).toBe('mac-app')
    expect(classifyArtifact('android/app/build/outputs/apk/debug/app-debug.apk')).toBe('android-apk')
    expect(classifyArtifact('README.md')).toBeNull()
  })

  it('accepts a complete architecture-consistent release', () => {
    expect(validateArtifactSet(validRecords())).toEqual([])
  })

  it('reports missing helpers architecture mismatches and invalid signatures', () => {
    const records = validRecords().filter((record) => !record.path.includes('EchoPasteHelper'))
    const runtime = records.find((record) => record.path.endsWith('/Echo.exe'))!
    runtime.fileOutput = 'PE32+ executable ARM64'
    const app = records.find((record) => record.path.endsWith('Echo.app'))!
    app.signatureValid = false
    app.helperFileOutputs = ['Mach-O 64-bit executable x86_64']

    expect(validateArtifactSet(records)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('EchoPasteHelper.exe'),
        expect.stringContaining('Windows runtime must be x86-64'),
        expect.stringContaining('macOS signature'),
        expect.stringContaining('native helpers must be arm64')
      ]),
    )
  })
})
