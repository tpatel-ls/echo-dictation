import { describe, expect, it } from 'vitest'
import { helperPath } from '../src/main/native/helper-path'

describe('helperPath', () => {
  it('uses Windows executables under packaged resources', () => {
    expect(helperPath('EchoKeyHelper', 'win32', 'C:\\Echo\\resources')).toBe(
      'C:\\Echo\\resources\\native\\EchoKeyHelper.exe'
    )
    expect(helperPath('EchoSpeechHelper', 'win32', 'C:\\Echo\\resources')).toBe(
      'C:\\Echo\\resources\\native\\EchoSpeechHelper.exe'
    )
  })

  it('uses the signed speech app bundle on macOS and plain Mach-O helpers otherwise', () => {
    expect(helperPath('EchoSpeechHelper', 'darwin', '/Echo/Resources')).toBe(
      '/Echo/Resources/native/EchoSpeechHelper.app/Contents/MacOS/EchoSpeechHelper'
    )
    expect(helperPath('EchoKeyHelper', 'darwin', '/Echo/Resources')).toBe(
      '/Echo/Resources/native/EchoKeyHelper'
    )
  })

  it('resolves development output when resources are absent', () => {
    expect(helperPath('EchoPasteHelper', 'win32', undefined, 'C:\\repo')).toBe(
      'C:\\repo\\out\\native\\EchoPasteHelper.exe'
    )
    expect(helperPath('EchoPasteHelper', 'darwin', undefined, '/repo')).toBe('/repo/out/native/EchoPasteHelper')
  })
})
