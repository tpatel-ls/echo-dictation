import { describe, it, expect } from 'vitest'
import {
  isFillerOnly,
  SHORT_CLIP_S,
  batchSegments,
  buildAsrSegments,
  chooseSegmentText,
  punctuateFromCheck,
  dropMicBleed,
  filterMicSegments,
  isBleed,
  mergeUtterances,
  selfSpeakerLabel
} from '@shared/meeting-transcript'
import type { AsrSegment, DiarizationResult, DiarizedTurn, MeetingUtterance } from '@shared/meeting-types'

const RATE = 16_000

function turn(start: number, end: number, speaker: string): DiarizedTurn {
  return { start, end, speaker }
}

function seg(id: string, start: number, end: number, speaker = 'A'): AsrSegment {
  return { id, start, end, speaker }
}

function spans(segments: AsrSegment[]): Array<[number, number, string]> {
  return segments.map((s) => [s.start, s.end, s.speaker])
}

describe('buildAsrSegments', () => {
  it('merges same-speaker turns closer than 0.8 s, and pads without overlapping by more than the pad', () => {
    const out = buildAsrSegments([turn(0, 2, 'A'), turn(2.5, 4, 'A'), turn(4.2, 6, 'B'), turn(6.8, 8, 'B')], null, 10, 's')
    expect(spans(out)).toEqual([
      [0, 4.2, 'A'],
      [4, 6.2, 'B'],
      [6.6, 8.2, 'B']
    ])
  })

  it('does not merge at a gap of exactly 0.8 s', () => {
    const out = buildAsrSegments([turn(1, 2, 'A'), turn(2.8, 4, 'A')], null, 10, 's')
    expect(out).toHaveLength(2)
  })

  it('splits back-to-back padding between speakers so the overlap stays at the pad', () => {
    const out = buildAsrSegments([turn(1, 5, 'A'), turn(5, 9, 'B')], null, 20, 's')
    expect(spans(out)).toEqual([
      [0.8, 5.1, 'A'],
      [4.9, 9.2, 'B']
    ])
  })

  it('clamps padding to the audio', () => {
    const out = buildAsrSegments([turn(0.1, 3, 'A'), turn(7, 9.95, 'B')], null, 10, 's')
    expect(spans(out)).toEqual([
      [0, 3.2, 'A'],
      [6.8, 10, 'B']
    ])
  })

  it('numbers segments in time order, whatever the input order', () => {
    const out = buildAsrSegments([turn(5, 7, 'B'), turn(0, 2, 'A')], null, 10, 'others-')
    expect(out.map((s) => [s.id, s.speaker])).toEqual([
      ['others-0', 'A'],
      ['others-1', 'B']
    ])
  })

  it('splits segments over 30 s evenly without audio', () => {
    const out = buildAsrSegments([turn(0, 70, 'A')], null, 100, 's', { padS: 0 })
    expect(out).toHaveLength(3)
    for (const s of out) expect(s.end - s.start).toBeLessThanOrEqual(30)
    expect(out[0].start).toBe(0)
    expect(out[2].end).toBe(70)
    expect(out[1].start).toBe(out[0].end)
  })

  it('splits segments over 30 s at the quietest point', () => {
    const samples = new Int16Array(50 * RATE)
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(8000 * Math.sin(i / 3))
    samples.fill(0, 22 * RATE, Math.round(22.5 * RATE))
    const out = buildAsrSegments([turn(0, 50, 'A')], samples, 50, 's', { padS: 0 })
    expect(out).toHaveLength(2)
    expect(out[0].end).toBeGreaterThan(22)
    expect(out[0].end).toBeLessThan(22.5)
    expect(out[1].start).toBe(out[0].end)
  })

  it('never leaves a sliver when a segment is just over 30 s', () => {
    const out = buildAsrSegments([turn(0, 31, 'A')], null, 40, 's', { padS: 0 })
    expect(out.map((s) => s.end - s.start)).toEqual([15.5, 15.5])
  })

  it('drops an isolated turn under 0.3 s and keeps one between 0.3 and 0.6 s', () => {
    const out = buildAsrSegments([turn(0, 3, 'A'), turn(5, 5.2, 'B'), turn(8, 8.4, 'C'), turn(11, 14, 'A')], null, 20, 's')
    expect(out.map((s) => s.speaker)).toEqual(['A', 'C', 'A'])
  })

  it('folds a short turn into the same speaker once a dropped blip no longer separates them', () => {
    // A 0.1 s blip from B splits A; dropping it rejoins A's turns into one segment.
    const out = buildAsrSegments([turn(0, 4, 'A'), turn(4.1, 4.2, 'B'), turn(4.3, 4.7, 'A')], null, 10, 's')
    expect(spans(out)).toEqual([[0, 4.9, 'A']])
  })

  it('handles no turns', () => {
    expect(buildAsrSegments([], null, 10, 's')).toEqual([])
  })
})

describe('batchSegments', () => {
  it('groups consecutive segments into windows of at most 5 minutes', () => {
    const segments = [seg('a', 0, 100), seg('b', 120, 290), seg('c', 295, 310), seg('d', 320, 400)]
    const batches = batchSegments(segments)
    expect(batches.map((b) => [b.start, b.end, b.segments.map((s) => s.id)])).toEqual([
      [0, 290, ['a', 'b']],
      [295, 400, ['c', 'd']]
    ])
  })

  it('never splits a segment that is longer than a batch', () => {
    const batches = batchSegments([seg('a', 0, 10), seg('b', 20, 400), seg('c', 401, 402)], 60)
    expect(batches.map((b) => b.segments.map((s) => s.id))).toEqual([['a'], ['b'], ['c']])
  })

  it('handles no segments', () => {
    expect(batchSegments([])).toEqual([])
  })
})

describe('punctuateFromCheck', () => {
  // Granite with a keyword list often drops sentence punctuation; Parakeet keeps it.
  it('borrows sentence breaks and capitals from the check, keeping the primary words', () => {
    expect(
      punctuateFromCheck(
        'we signed the renewal for the Zeltra contract so they are adding a support plan',
        'We signed the renewal for the zebra contract. So they are adding a support plan.'
      )
    ).toBe('We signed the renewal for the Zeltra contract. So they are adding a support plan.')
  })

  it('leaves text that is already as well punctuated as the check', () => {
    const text = 'Okay, can you share the Zeltra login? Okay, no worries.'
    expect(punctuateFromCheck(text, 'Okay can you share the zebra login. Okay no worries.')).toBe(text)
  })

  it('leaves the text alone when the check heard something else, or nothing', () => {
    const text = 'kians back on monday shell review it then'
    expect(punctuateFromCheck(text, 'Keen back. On Monday she will go.')).toBe(text)
    expect(punctuateFromCheck(text, '')).toBe(text)
  })
})

describe('chooseSegmentText', () => {
  const P = 'canary-qwen-2.5b'
  const C = 'parakeet-tdt-0.6b-v2'

  it('keeps the primary when both agree, returning its original text', () => {
    expect(chooseSegmentText({ [P]: 'Let’s ship it on Friday.', [C]: 'lets ship it on friday' }, P, C)).toBe(
      'Let’s ship it on Friday.'
    )
  })

  it('falls back to the check when the primary is missing or empty', () => {
    expect(chooseSegmentText({ [C]: 'Ship it Friday.' }, P, C)).toBe('Ship it Friday.')
    expect(chooseSegmentText({ [P]: '  ', [C]: 'Ship it Friday.' }, P, C)).toBe('Ship it Friday.')
    expect(chooseSegmentText({}, P, C)).toBe('')
  })

  it('drops a short primary when the check heard nothing (hallucination on noise)', () => {
    expect(chooseSegmentText({ [P]: 'Thank you.', [C]: '' }, P, C)).toBe('')
    expect(chooseSegmentText({ [P]: 'I see it.', [C]: '' }, P, C)).toBe('')
    expect(chooseSegmentText({ [P]: 'We should ship on Friday.', [C]: '' }, P, C)).toBe('We should ship on Friday.')
  })

  it('drops known silence phrases when the check heard nothing', () => {
    expect(chooseSegmentText({ [P]: 'Thank you for watching!', [C]: '' }, P, C)).toBe('')
    expect(chooseSegmentText({ [P]: 'Bye.', [C]: '' }, P, C)).toBe('')
    expect(chooseSegmentText({ [P]: 'You', [C]: '' }, P, C)).toBe('')
  })

  it('prefers the check over a runaway, looping primary', () => {
    const loop = 'and then we and then we and then we and then we and then we'
    expect(chooseSegmentText({ [P]: loop, [C]: 'and then we left' }, P, C)).toBe('and then we left')
  })

  it('keeps a longer primary that mostly agrees with the check', () => {
    const texts = { [P]: 'So the plan is to ship it on Friday morning.', [C]: 'so the plan is ship it friday' }
    expect(chooseSegmentText(texts, P, C)).toBe('So the plan is to ship it on Friday morning.')
  })

  it('trusts the primary when the check model failed on the segment', () => {
    expect(chooseSegmentText({ [P]: 'Thank you.' }, P, C)).toBe('Thank you.')
  })
})

describe('selfSpeakerLabel', () => {
  const result = (speakers: Array<[string, number]>): DiarizationResult => ({
    duration: 60,
    model: 'm',
    embeddingModel: 'e',
    embeddingDim: 256,
    segments: [],
    speakers: speakers.map(([id, speechSeconds]) => ({ id, speechSeconds, turns: 1, embedding: null }))
  })

  it('is the speaker with the most speech', () => {
    expect(selfSpeakerLabel(result([['SPEAKER_00', 4], ['SPEAKER_01', 40], ['SPEAKER_02', 9]]))).toBe('SPEAKER_01')
  })

  it('is null without speakers', () => {
    expect(selfSpeakerLabel(result([]))).toBeNull()
  })
})

describe('filterMicSegments', () => {
  const others = [turn(10, 20, 'SPEAKER_00')]

  it('keeps the self speaker even over others speech', () => {
    const out = filterMicSegments([seg('m0', 12, 18, 'ME')], 'ME', others)
    expect(out.map((s) => s.id)).toEqual(['m0'])
  })

  it('drops a non-self segment mostly overlapping others speech (bleed), keeps one in the clear', () => {
    const out = filterMicSegments(
      [seg('m0', 11, 15, 'X'), seg('m1', 18, 22, 'X'), seg('m2', 19, 25, 'X'), seg('m3', 30, 32, 'X')],
      'ME',
      others
    )
    // m1: 2 of 4 s overlap (50%) → bleed. m2: 1 of 6 s → someone in the room.
    expect(out.map((s) => s.id)).toEqual(['m2', 'm3'])
  })

  it('treats every segment as non-self without a self label', () => {
    expect(filterMicSegments([seg('m0', 12, 14, 'X'), seg('m1', 40, 42, 'X')], null, others).map((s) => s.id)).toEqual(['m1'])
  })
})

describe('isBleed', () => {
  it('holds when most mic words appear in the overlapping others speech', () => {
    expect(isBleed('ship it on Friday', ['We should ship it', 'on Friday, yes.'])).toBe(true)
  })

  it('does not hold for different words', () => {
    expect(isBleed('sounds good to me', ['We should ship it on Friday'])).toBe(false)
  })

  it('needs at least two mic words', () => {
    expect(isBleed('Friday', ['ship it on Friday'])).toBe(false)
  })

  it('is false with no others speech', () => {
    expect(isBleed('ship it on Friday', [])).toBe(false)
  })
})

describe('dropMicBleed', () => {
  const u = (start: number, end: number, channel: 'mic' | 'others', text: string): MeetingUtterance => ({
    start,
    end,
    channel,
    speakerKey: channel === 'mic' ? 'me' : 'others',
    text
  })

  it('removes mic utterances echoing overlapping others speech, within the tolerance', () => {
    const utterances = [
      u(0, 4000, 'others', 'we should ship it on Friday'),
      u(5000, 8000, 'mic', 'ship it on Friday'),
      u(9000, 12_000, 'mic', 'sounds good to me'),
      u(20_000, 22_000, 'mic', 'ship it on Friday')
    ]
    expect(dropMicBleed(utterances).map((x) => x.start)).toEqual([0, 9000, 20_000])
    expect(dropMicBleed(utterances, 500).map((x) => x.start)).toEqual([0, 5000, 9000, 20_000])
  })
})

describe('mergeUtterances', () => {
  const u = (start: number, end: number, speakerKey: string, text: string, channel: 'mic' | 'others' = 'others') => ({
    start,
    end,
    channel,
    speakerKey,
    text
  })

  it('merges adjacent same-speaker utterances on the same channel closer than 1.5 s', () => {
    const out = mergeUtterances([
      u(3000, 4000, 'others:A', 'we ship'),
      u(0, 2000, 'others:A', 'so'),
      u(5600, 7000, 'others:A', 'later'),
      u(7200, 8000, 'others:B', 'ok'),
      u(8100, 9000, 'me', 'fine', 'mic'),
      u(9100, 9500, 'me', 'yes', 'mic')
    ])
    expect(out).toEqual([
      u(0, 4000, 'others:A', 'so we ship'),
      u(5600, 7000, 'others:A', 'later'),
      u(7200, 8000, 'others:B', 'ok'),
      u(8100, 9500, 'me', 'fine yes', 'mic')
    ])
  })

  it('does not merge the same key across channels', () => {
    const out = mergeUtterances([u(0, 1000, 'x', 'a', 'mic'), u(1100, 2000, 'x', 'b', 'others')])
    expect(out).toHaveLength(2)
  })
})

describe('mergeUtterances with a length cap', () => {
  it('never grows an utterance past maxMs, so long monologues stay citable', () => {
    const u = (start: number, end: number): MeetingUtterance => ({ start, end, channel: 'others', speakerKey: 'others', text: `t${start}` })
    const chunks = [u(0, 25_000), u(25_000, 50_000), u(50_000, 75_000), u(75_000, 100_000)]
    expect(mergeUtterances(chunks).length).toBe(1)
    expect(mergeUtterances(chunks, 1500, 60_000).map((x) => [x.start, x.end])).toEqual([
      [0, 50_000],
      [50_000, 100_000]
    ])
  })
})

describe('mergeUtterances: sentence breaks between joined fragments', () => {
  const u = (start: number, text: string): MeetingUtterance => ({ start, end: start + 2000, channel: 'others', speakerKey: 'others:A', text })
  it('ends an unpunctuated fragment with a period when the next one starts a sentence', () => {
    const merged = mergeUtterances([u(0, 'That is great news'), u(2500, 'Is anything still blocking the build?'), u(5000, 'I will check')])
    expect(merged.map((m) => m.text)).toEqual(['That is great news. Is anything still blocking the build? I will check'])
  })
  it('leaves fragments that continue a sentence alone', () => {
    const merged = mergeUtterances([u(0, 'we should ship'), u(2500, 'on Friday, if possible,'), u(5000, 'and not later')])
    expect(merged.map((m) => m.text)).toEqual(['we should ship on Friday, if possible, and not later'])
  })
})

describe('chooseSegmentText on short clips (hums and clicks heard as words)', () => {
  const P = 'canary-qwen-2.5b'
  const C = 'parakeet-tdt-0.6b-v2'
  it('uses the primary on a short clip only when the check broadly agrees', () => {
    expect(SHORT_CLIP_S).toBe(1.5)
    expect(chooseSegmentText({ [P]: 'Amen', [C]: 'Mm-hmm' }, P, C, 0.9)).toBe('Mm-hmm')
    expect(chooseSegmentText({ [P]: "Hold on then", [C]: 'Okay' }, P, C, 1.1)).toBe('Okay')
    expect(chooseSegmentText({ [P]: 'Yeah, sure.', [C]: 'Yeah sure' }, P, C, 1.2)).toBe('Yeah, sure.')
    // Longer clips keep the existing rules: the primary wins.
    expect(chooseSegmentText({ [P]: 'Right, fine', [C]: 'Alright then' }, P, C, 3)).toBe('Right, fine')
    expect(chooseSegmentText({ [P]: 'Right, fine', [C]: 'Alright then' }, P, C, 1)).toBe('Alright then')
    // No duration given: the existing rules.
    expect(chooseSegmentText({ [P]: 'Amen', [C]: 'Mm-hmm' }, P, C)).toBe('Amen')
  })

  it('keeps a hum a hum when the models disagree on it ("Okay." for "Mhm")', () => {
    expect(chooseSegmentText({ [P]: 'Mm-hmm', [C]: 'Okay.' }, P, C, 0.6)).toBe('Mm-hmm')
    expect(chooseSegmentText({ [P]: 'Mm', [C]: 'Okay.' }, P, C, 0.6)).toBe('Mm-hmm')
    expect(chooseSegmentText({ [P]: 'Yeah', [C]: 'Mhm' }, P, C, 0.6)).toBe('Mm-hmm')
    // Both hear the same backchannel: unchanged.
    expect(chooseSegmentText({ [P]: 'Okay.', [C]: 'Okay' }, P, C, 0.6)).toBe('Okay.')
  })

  it('keeps the primary on a short clip when the check failed on it (no evidence)', () => {
    expect(chooseSegmentText({ [P]: 'Okay' }, P, C, 0.8)).toBe('Okay')
  })
})

describe('isFillerOnly', () => {
  it('flags hesitation sounds, not backchannels', () => {
    for (const t of ['Um', 'um.', 'Uh,', 'Hmm', 'Mm', 'uh um', 'Erm...']) expect(isFillerOnly(t)).toBe(true)
    for (const t of ['Mm-hmm', 'Yeah', 'Okay.', 'Uh-huh', 'Mm no I think', 'Um, sure']) expect(isFillerOnly(t)).toBe(false)
  })
})
