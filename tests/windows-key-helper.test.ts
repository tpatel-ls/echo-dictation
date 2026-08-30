import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Windows key helper', () => {
  it('uses global Raw Input rather than a low-level keyboard hook', () => {
    const source = readFileSync('native/windows/EchoKeyHelper/Program.cs', 'utf8')
    const project = readFileSync('native/windows/EchoKeyHelper/EchoKeyHelper.csproj', 'utf8')
    const listener = readFileSync('src/main/hotkey/listener.ts', 'utf8')

    expect(project).toContain('<UseWindowsForms>true</UseWindowsForms>')
    expect(project).toContain('<OutputType>WinExe</OutputType>')
    expect(source).toContain('[STAThread]')
    expect(source).toContain('RidevInputSink')
    expect(source).toContain('RegisterRawInputDevices(')
    expect(source).toContain('GetRawInputData(')
    expect(source).not.toContain('SetWindowsHookEx(')
    expect(source).not.toContain('GetMessage(')
    expect(listener).toContain('windowsHide: false')
  })
})
