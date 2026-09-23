import { describe, expect, it } from 'vitest'
import type { MeetingSegment, MeetingSpeaker, MeetingSummary } from '@shared/meeting-types'
import {
  dayLabel,
  errorText,
  formatClock,
  formatElapsed,
  formatMeetingLength,
  groupByDay,
  speakerColors,
  speakerLabel,
  transcriptText,
  utteranceIds,
  visibleNames
} from '../src/renderer/dashboard/lib/meeting-view'

const NOW = new Date(2026, 8, 22, 15, 0, 0).getTime()

function summary(id: number, started: Date): MeetingSummary {
  return {
    id,
    started_at: started.getTime(),
    ended_at: started.getTime() + 60_000,
    app: 'zoom',
    title: null,
    status: 'ready',
    progress: null,
    speakers: []
  }
}

function segment(idx: number, speakerKey: string, text: string, startMs = idx * 1000): MeetingSegment {
  return {
    id: 100 + idx,
    meeting_id: 1,
    idx,
    start_ms: startMs,
    end_ms: startMs + 900,
    channel: speakerKey === 'me' ? 'mic' : 'others',
    speaker_key: speakerKey,
    text,
    pass: 'final'
  }
}

function speaker(key: string, label: string): MeetingSpeaker {
  return { key, label, source: 'user', personId: null, suggestion: null, score: null, seconds: 10 }
}

describe('dayLabel', () => {
  it('names today and yesterday and dates anything older', () => {
    expect(dayLabel(new Date(2026, 8, 22, 9).getTime(), NOW)).toBe('Today')
    expect(dayLabel(new Date(2026, 8, 21, 23, 59).getTime(), NOW)).toBe('Yesterday')
    const older = dayLabel(new Date(2026, 8, 1, 10).getTime(), NOW)
    expect(older).not.toBe('Today')
    expect(older).not.toBe('Yesterday')
    expect(older).toMatch(/1/)
  })
})

describe('groupByDay', () => {
  it('groups meetings by calendar day, keeping the given order', () => {
    const groups = groupByDay([
      summary(3, new Date(2026, 8, 22, 14)),
      summary(2, new Date(2026, 8, 22, 9)),
      summary(1, new Date(2026, 8, 21, 16))
    ], NOW)
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday'])
    expect(groups[0].items.map((m) => m.id)).toEqual([3, 2])
    expect(groups[1].items.map((m) => m.id)).toEqual([1])
  })
})

describe('time formatting', () => {
  it('formats elapsed time as mm:ss, or h:mm:ss past an hour', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(65_400)).toBe('01:05')
    expect(formatElapsed(3_725_000)).toBe('1:02:05')
    expect(formatElapsed(-50)).toBe('00:00')
  })

  it('formats transcript offsets as hh:mm:ss', () => {
    expect(formatClock(0)).toBe('00:00:00')
    expect(formatClock(3_725_999)).toBe('01:02:05')
  })

  it('describes a meeting length in minutes', () => {
    expect(formatMeetingLength(0, 20_000)).toBe('< 1 min')
    expect(formatMeetingLength(0, 42 * 60_000)).toBe('42 min')
    expect(formatMeetingLength(0, 65 * 60_000)).toBe('1 h 5 min')
    expect(formatMeetingLength(0, 120 * 60_000)).toBe('2 h')
    expect(formatMeetingLength(0, null)).toBe('')
  })
})

describe('utteranceIds', () => {
  it('numbers utterances u1, u2, ... in segment order', () => {
    const ids = utteranceIds([segment(2, 'me', 'c'), segment(0, 'me', 'a'), segment(1, 'others', 'b')])
    expect(ids.get(100)).toBe('u1')
    expect(ids.get(101)).toBe('u2')
    expect(ids.get(102)).toBe('u3')
  })
})

describe('speakers', () => {
  it('uses the speaker label, then a numbered fallback', () => {
    const speakers = [speaker('me', 'Tanay'), speaker('others:SPEAKER_00', 'Blake Whitmore')]
    expect(speakerLabel('others:SPEAKER_00', speakers)).toBe('Blake Whitmore')
    expect(speakerLabel('others', speakers)).toBe('Others')
    expect(speakerLabel('me', [])).toBe('You')
    expect(speakerLabel('others:SPEAKER_03', [])).toBe('Speaker 4')
  })

  it('gives each remote speaker its own colour, stable regardless of who spoke first', () => {
    const a = speakerColors([segment(0, 'others:SPEAKER_01', 'x'), segment(1, 'others:SPEAKER_00', 'y')])
    const b = speakerColors([segment(0, 'others:SPEAKER_00', 'y'), segment(1, 'others:SPEAKER_01', 'x')])
    expect(a.get('others:SPEAKER_00')).toBe(b.get('others:SPEAKER_00'))
    expect(a.get('others:SPEAKER_00')).not.toBe(a.get('others:SPEAKER_01'))
    expect(a.has('me')).toBe(false)
  })

  it('shows up to three names and counts the rest', () => {
    expect(visibleNames(['A', 'B'])).toEqual({ shown: ['A', 'B'], more: 0 })
    expect(visibleNames(['A', 'B', 'C', 'D', 'E'])).toEqual({ shown: ['A', 'B', 'C'], more: 2 })
  })
})

describe('errorText', () => {
  it('strips the IPC wrapper so a missing handler reads cleanly in a toast', () => {
    const e = new Error("Error invoking remote method 'meetings:list': Error: No handler registered for 'meetings:list'")
    expect(errorText(e)).toBe("No handler registered for 'meetings:list'")
    expect(errorText('offline')).toBe('offline')
    expect(errorText(new Error('x'.repeat(200)))).toHaveLength(80)
  })
})

describe('transcriptText', () => {
  it('renders one timestamped, speaker-labelled line per utterance', () => {
    const text = transcriptText(
      [segment(1, 'others:SPEAKER_00', 'Hi there.', 61_000), segment(0, 'me', 'Hello.', 0)],
      [speaker('me', 'Tanay'), speaker('others:SPEAKER_00', 'Blake')]
    )
    expect(text).toBe('[00:00:00] Tanay: Hello.\n[00:01:01] Blake: Hi there.')
  })
})
