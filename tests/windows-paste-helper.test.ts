import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Windows paste helper', () => {
  it('matches the native x64 INPUT ABI and reports actionable SendInput diagnostics', () => {
    const source = readFileSync('native/windows/EchoPasteHelper/Program.cs', 'utf8')

    expect(source).toContain('private struct MouseInput')
    expect(source).toContain('[FieldOffset(0)] public MouseInput mouse;')
    expect(source).toContain('Marshal.GetLastWin32Error()')
    expect(source).toContain('expectedInputSize')
    expect(source).toContain('inputSize')
  })

  it('serves pastes from a warm process and checks server mode before the legacy --check flag', () => {
    const source = readFileSync('native/windows/EchoPasteHelper/Program.cs', 'utf8')

    expect(source).toContain('Console.ReadLine()')
    expect(source.indexOf('"--server"')).toBeLessThan(source.indexOf('"--check"'))
  })
})
