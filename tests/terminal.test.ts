import { describe, it, expect } from 'vitest'
import { looksLikeTerminal } from '../src/main/insert/terminal'

describe('looksLikeTerminal', () => {
  it('matches Windows shells where Ctrl+C means SIGINT', () => {
    expect(looksLikeTerminal('Windows PowerShell')).toBe(true)
    expect(looksLikeTerminal('Administrator: Windows PowerShell')).toBe(true)
    expect(looksLikeTerminal('C:\\WINDOWS\\system32\\cmd.exe')).toBe(true)
    expect(looksLikeTerminal('Command Prompt')).toBe(true)
    expect(looksLikeTerminal('Windows Terminal')).toBe(true)
    expect(looksLikeTerminal('MINGW64:/c/Users/Tanay')).toBe(true)
  })

  it('matches macOS / Linux terminals', () => {
    expect(looksLikeTerminal('Terminal')).toBe(true)
    expect(looksLikeTerminal('iTerm2')).toBe(true)
    expect(looksLikeTerminal('tanay@host: ~/projects — WezTerm')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(looksLikeTerminal('WINDOWS POWERSHELL')).toBe(true)
  })

  it('does not match normal editor / browser / document windows', () => {
    expect(looksLikeTerminal('Untitled - Notepad')).toBe(false)
    expect(looksLikeTerminal('Inbox - Gmail - Google Chrome')).toBe(false)
    expect(looksLikeTerminal('dictation.ts - voiceapp - Visual Studio Code')).toBe(false)
    expect(looksLikeTerminal('Payment Terms - Word')).toBe(false)
    expect(looksLikeTerminal('')).toBe(false)
    expect(looksLikeTerminal('Unknown')).toBe(false)
  })
})
