import { describe, it, expect } from 'vitest'
import { registerForTitle, styleDirective } from '../src/shared/app-style'

describe('registerForTitle', () => {
  it('classifies chat apps as casual', () => {
    expect(registerForTitle('Slack | general — Tanay')).toBe('casual')
    expect(registerForTitle('WhatsApp')).toBe('casual')
    expect(registerForTitle('Discord')).toBe('casual')
  })

  it('classifies mail as professional', () => {
    expect(registerForTitle('Inbox (3) - tanay@gmail.com - Google Chrome')).toBe('professional')
    expect(registerForTitle('Outlook')).toBe('professional')
  })

  it('classifies editors and terminals as technical', () => {
    expect(registerForTitle('dictation.ts - voiceapp - Visual Studio Code')).toBe('technical')
    expect(registerForTitle('Windows PowerShell')).toBe('technical')
  })

  it('defaults unknown titles to neutral', () => {
    expect(registerForTitle('Some Random Window')).toBe('neutral')
    expect(registerForTitle('')).toBe('neutral')
  })
})

describe('styleDirective', () => {
  it('returns null for neutral so the base cleanup prompt is used as-is', () => {
    expect(styleDirective('neutral')).toBeNull()
  })

  it('asks for professional formatting', () => {
    expect(styleDirective('professional')).toMatch(/professional/i)
  })

  it('asks for a casual tone', () => {
    expect(styleDirective('casual')).toMatch(/casual/i)
  })
})
