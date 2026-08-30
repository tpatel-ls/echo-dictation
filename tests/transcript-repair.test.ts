import { describe, expect, it } from 'vitest'
import { repairTranscriptConsistency } from '@shared/transcript-repair'

describe('repairTranscriptConsistency', () => {
  it('uses a later joined spelling to repair an earlier split of the same word', () => {
    expect(
      repairTranscriptConsistency(
        'We need to go to the plant ain station and get plantain chips.'
      )
    ).toBe('We need to go to the plantain station and get plantain chips.')
  })

  it('repairs every repeated split while preserving punctuation and capitalization', () => {
    expect(
      repairTranscriptConsistency('Plant ain is here. PLANT AIN chips are plantain chips.')
    ).toBe('Plantain is here. Plantain chips are plantain chips.')
  })

  it('does not join ordinary adjacent words without evidence elsewhere in the transcript', () => {
    expect(repairTranscriptConsistency('Please send the plant inventory today.')).toBe(
      'Please send the plant inventory today.'
    )
  })

  it('does not collapse short ambiguous phrases such as a long', () => {
    expect(repairTranscriptConsistency('It was a long walk along the river.')).toBe(
      'It was a long walk along the river.'
    )
  })
})
