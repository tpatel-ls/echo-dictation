import { describe, expect, it } from 'vitest'
import { assessTranscript, chooseTranscript } from '@shared/transcript-quality'

describe('assessTranscript', () => {
  it('keeps deterministic forbidden letters rejected and marks other wrong-language output non-clean', () => {
    expect(assessTranscript('Einn snop og þá minn ekki röggli og feitsið gís.', { language: 'en' }).grade)
      .toBe('reject')
    expect(assessTranscript('Oddváey, Foss, sýttir á.', { language: 'en' }).grade).toBe('suspicious')
    expect(assessTranscript('Einn snop and sýttir á röggli feitsí gís.', { language: 'en' }).grade)
      .toBe('suspicious')
  })

  it('flags broken multiword English as suspicious', () => {
    expect(assessTranscript('How do I force figure out?', { language: 'en' }).grade).toBe('suspicious')
  })

  it('flags short low-english-evidence garble at four words', () => {
    expect(assessTranscript('einn snop gisi takk', { language: 'en' }).grade).toBe('suspicious')
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

  it('rejects non-Latin script leakage in English-only mode unless it is a glossary term', () => {
    expect(assessTranscript('Another хожу guy.', { language: 'en' })).toMatchObject({
      grade: 'reject',
      reasons: expect.arrayContaining(['non-latin-script'])
    })
    expect(assessTranscript('Open 東京 now.', { language: 'en' }).grade).toBe('reject')
    expect(assessTranscript('Open 東京 now.', { language: 'en', glossary: ['東京'] }).grade).toBe('clean')
  })

  it('rejects plain transcript wrappers and known assistant-reply phrases', () => {
    expect(assessTranscript('Here is the transcript: It is not working correctly.', { language: 'en' }).grade)
      .toBe('reject')
    expect(assessTranscript('Sure, here is the transcript: It is not working correctly.', { language: 'en' }).grade)
      .toBe('reject')
    expect(assessTranscript('Here is the transcription: It is not working correctly.', { language: 'en' }).grade)
      .toBe('reject')
    expect(assessTranscript('Here is the result: It is not working correctly.', { language: 'en' }).grade)
      .toBe('reject')
    expect(assessTranscript('Here is the final version: It is not working correctly.', { language: 'en' }).grade)
      .toBe('reject')
    expect(assessTranscript("You're welcome.", { language: 'en' }).grade).toBe('reject')
    expect(assessTranscript('Let me know if you need anything else.', { language: 'en' }).grade).toBe('reject')
    expect(assessTranscript('How can I help?', { language: 'en' }).grade).toBe('reject')
    expect(assessTranscript("I'd be happy to help.", { language: 'en' }).grade).toBe('reject')
  })

  it('does not reject genuine dictation with accented names or plain here-is phrasing', () => {
    expect(assessTranscript('Here is the plan: deploy after lunch.', { language: 'en' }).grade).toBe('clean')
    expect(assessTranscript('Jose met Zoe in Montreal.', { language: 'en' }).grade).toBe('clean')
    expect(assessTranscript('José met Zoë in Montréal.', { language: 'en' }).grade).toBe('clean')
    expect(assessTranscript('please email josé and zoë in montréal', { language: 'en' }).grade).toBe('clean')
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

  it('returns null when every candidate is deterministically rejected', () => {
    expect(chooseTranscript([
      { source: 'remote-primary', text: ' ... ', elapsedMs: 300 },
      { source: 'native', text: "You're welcome.", elapsedMs: 200 }
    ], { language: 'en' })).toBeNull()
  })

  it('ignores wrapper candidates and keeps accented-name dictation eligible', () => {
    expect(chooseTranscript([
      { source: 'remote-primary', text: 'Here is the transcript: It is not working correctly.', elapsedMs: 100 },
      { source: 'native', text: 'Here is the plan: deploy after lunch.', elapsedMs: 200 }
    ], { language: 'en' })?.source).toBe('native')

    expect(chooseTranscript([
      { source: 'remote-primary', text: 'Oddváey, Foss, sýttir á.', elapsedMs: 100 },
      { source: 'native', text: 'José met Zoë in Montréal.', elapsedMs: 200 }
    ], { language: 'en' })?.source).toBe('native')
  })
})
