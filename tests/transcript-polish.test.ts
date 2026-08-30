import { describe, expect, it } from 'vitest'
import { polishTranscriptStructure } from '@shared/transcript-polish'

describe('polishTranscriptStructure', () => {
  it('repairs common ASR possessives for product and company names', () => {
    expect(polishTranscriptStructure('Anthropics went down, while the Codexs limits went up.')).toBe(
      "Anthropic's went down, while the Codex's limits went up."
    )
  })

  it('restores conventional casing for common technical product names', () => {
    expect(polishTranscriptStructure('The codex update was posted to github by open ai.')).toBe(
      'The Codex update was posted to GitHub by OpenAI.'
    )
  })

  it('organizes a long monologue around topic transitions without changing its words', () => {
    const input =
      "Unsurprisingly, so a little more about that. What does it mean practically? You're looking essentially at 20%, right? 17 to 20%. So one fifth of the capacity is chopped straight off. This comes right after an announcement by Tebow, who's sort of the Codex lead. You can kind of think of it as a spiritual competitor to Boris Journey. The two really do need to duke it out in a gladiatorial arena at some point, saying that the Codex usage limits have increased significantly because they ironed out a bunch of bugs that were consuming additional tokens without telling you. So they, I don't know if in reaction to this news, are basically doing the exact different thing. Anthropics went down, the Codex is going up. So yeah."

    const output = polishTranscriptStructure(input)

    expect(output).toContain("\n\nThis comes right after")
    expect(output).toContain("\n\nSo they, I don't know")
    expect(output).toContain("Anthropic's went down")
    expect(output).toContain('the Codex is going up')
    expect(output.split('\n\n')).toHaveLength(3)
  })

  it('does not over-paragraph short messages or disturb explicit paragraph breaks', () => {
    expect(polishTranscriptStructure('Anthropic released an update. Codex followed.')).toBe(
      'Anthropic released an update. Codex followed.'
    )
    expect(polishTranscriptStructure('First topic.\n\nSecond topic.')).toBe('First topic.\n\nSecond topic.')
  })
})
