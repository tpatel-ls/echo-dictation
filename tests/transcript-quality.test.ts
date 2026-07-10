import { describe, expect, it } from 'vitest'
import { assessTranscript, chooseTranscript } from '@shared/transcript-quality'

describe('assessTranscript', () => {
  it('rejects obvious wrong-language output', () => {
    expect(assessTranscript('Einn snop og þá minn ekki röggli og feitsið gís.', { language: 'en' }).grade)
      .toBe('reject')
    expect(assessTranscript('Oddváey, Foss, sýttir á.', { language: 'en' }).grade).toBe('reject')
  })

  it('flags broken multiword English as suspicious', () => {
    expect(assessTranscript('How do I force figure out?', { language: 'en' }).grade).toBe('suspicious')
  })

  it('keeps technical phrases and glossary terms clean', () => {
    expect(assessTranscript('Deploy PostgreSQL on GB10.', { language: 'en', glossary: ['GB10'] }).grade)
      .toBe('clean')
  })

  it('rejects empty or assistant-style content', () => {
    expect(assessTranscript(' ... ', { language: 'en' }).grade).toBe('reject')
    expect(assessTranscript('Sure, here is the cleaned transcript: It is not working correctly.', { language: 'en' }).grade)
      .toBe('reject')
  })
})

describe('chooseTranscript', () => {
  it('prefers the best-scoring candidate', () => {
    expect(chooseTranscript([
      { source: 'remote-primary', text: 'Einn snop og þá minn ekki röggli.', elapsedMs: 400 },
      { source: 'native', text: 'It is not working correctly.', elapsedMs: 520 }
    ], { language: 'en' })?.source).toBe('native')
  })

  it('breaks ties by source priority and keeps stable order otherwise', () => {
    expect(chooseTranscript([
      { source: 'remote-primary', text: 'Deploy PostgreSQL on GB10.', elapsedMs: 100 },
      { source: 'native', text: 'Deploy PostgreSQL on GB10.', elapsedMs: 200 }
    ], { language: 'en', glossary: ['GB10'] })?.source).toBe('native')

    const first = chooseTranscript([
      { source: 'remote-primary', text: 'Deploy PostgreSQL on GB10.', elapsedMs: 300 },
      { source: 'remote-primary', text: 'Deploy PostgreSQL on GB10.', elapsedMs: 100 }
    ], { language: 'en', glossary: ['GB10'] })
    expect(first?.elapsedMs).toBe(300)
  })

  it('returns null for an empty candidate list', () => {
    expect(chooseTranscript([], { language: 'en' })).toBeNull()
  })

  it('returns null when every candidate is rejected', () => {
    expect(chooseTranscript([
      { source: 'remote-primary', text: 'Einn snop og þá minn ekki röggli.', elapsedMs: 300 },
      { source: 'native', text: 'Oddváey, Foss, sýttir á.', elapsedMs: 200 }
    ], { language: 'en' })).toBeNull()
  })
})
