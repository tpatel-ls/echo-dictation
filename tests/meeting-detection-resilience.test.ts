import { describe, expect, it } from 'vitest'
import { continuationEvidence, detectMeetings, detectPlaybackMeetings, unconfirmedMeetings } from '@shared/meeting-detect'
import { MeetingSession } from '@shared/meeting-session'
import type { MeetingAppToggles, MicSession, ProbeResult } from '@shared/meeting-types'

const apps: MeetingAppToggles = { 'google-meet': true, teams: true, slack: true, zoom: true, webex: true }
const mic: MicSession = { pid: 11, appPid: 10, exe: 'chrome.exe', path: '', packageFamily: null, endpointId: 'mic', endpointName: '' }
function probe(name: string, peak = 0.1, extraTabs: string[] = []): ProbeResult {
  return { windows: [], tabs: [name, ...extraTabs].map(name => ({ appPid: 10, exe: 'chrome.exe', name })),
    render: [{ pid: 11, appPid: 10, exe: 'chrome.exe', endpointId: 'speakers', active: true, peak }] }
}

describe('meeting detection resilience', () => {
  it('uses a joined Meet control for a silent muted join, and a left control overrides stale alerts', () => {
    const p = probe('Meet - abc-defg-hij - Microphone recording - Audio playing')
    p.meetCalls = [{ appPid: 10, exe: 'chrome.exe', title: 'Meet - abc-defg-hij', state: 'joined',
      participants: ['Alex Rivera'], participantCount: 2, micMuted: true }]
    const candidate = detectPlaybackMeetings(p, apps)[0]
    expect(candidate).toMatchObject({ joined: true, callId: 'abc-defg-hij', micMuted: true,
      participants: [{ name: 'Alex Rivera', source: 'meet', rosterComplete: true }] })
    const session = new MeetingSession()
    session.observe(0, [candidate])
    expect(session.observe(3000, [candidate])[0]?.type).toBe('start')
    expect(session.observe(100_000, [], continuationEvidence(candidate, p))).toEqual([])
    p.meetCalls[0].state = 'left'
    expect(detectMeetings([mic], p, apps)).toEqual([])
    expect(detectPlaybackMeetings(p, apps)).toEqual([])
    expect(unconfirmedMeetings([mic], p, apps)).toEqual([])
    session.observe(101_000, [], continuationEvidence(candidate, p))
    expect(session.observe(105_000, [], continuationEvidence(candidate, p))).toEqual([{ type: 'stop', reason: 'ended' }])
  })
  it.each([' - New browser status', ' - Memory usage - 700 MB - New status', ' - Google Chrome']) (
    'keeps capture evidence when the browser appends %s', suffix => {
      expect(detectMeetings([mic], probe(`Meet - Weekly review - Camera and microphone recording${suffix}`), apps))
        .toEqual([expect.objectContaining({ app: 'google-meet', title: 'Weekly review' })])
    })

  it('starts a muted join from the meeting tab playback signal without a microphone event', () => {
    const candidates = detectPlaybackMeetings(probe('Meet - Weekly review - Audio playing - New status', 0), apps)
    expect(candidates).toEqual([expect.objectContaining({ micEndpointId: null, remoteAudio: true, requiresRemoteAudio: true })])
    const session = new MeetingSession()
    expect(session.observe(0, candidates)).toEqual([])
    expect(session.observe(1500, candidates)).toEqual([])
    expect(session.observe(3000, candidates)[0]?.type).toBe('start')
  })

  it('does not infer a muted meeting from a bare tab, another tab audio, or a camera lobby', () => {
    expect(detectPlaybackMeetings(probe('Meet - Weekly review'), apps)).toEqual([])
    expect(detectPlaybackMeetings(probe('Meet - Weekly review - Camera recording', 0.2, ['Video - Audio playing']), apps)).toEqual([])
    expect(detectPlaybackMeetings(probe('Meet - Weekly review - Camera recording', 0), apps)).toEqual([])
    const inactive = probe('Meet - Weekly review - Audio playing')
    inactive.render[0].active = false
    expect(detectPlaybackMeetings(inactive, apps)).toEqual([])
    expect(detectPlaybackMeetings(probe('Meet - Weekly review - Audio playing'), { ...apps, 'google-meet': false })).toEqual([])
  })

  it('requires an explicit start when browser labels provide only ambiguous call evidence', () => {
    const p = probe('Meet - Weekly review - Unknown capture status')
    const candidates = unconfirmedMeetings([mic], p, apps)
    expect(candidates).toEqual([expect.objectContaining({ requiresConfirmation: true })])
    const session = new MeetingSession()
    for (let time = 0; time <= 120_000; time += 1500) expect(session.observe(time, candidates)).toEqual([])
    expect(session.startNow(121_000)[0]?.type).toBe('start')
    expect(unconfirmedMeetings([mic], probe('Meet - Weekly review', 0.2, ['Voice notes - Microphone recording']), apps)).toEqual([])
  })

  it('never uses the alone timeout to start a playback-only candidate', () => {
    const candidate = detectPlaybackMeetings(probe('Meet - Weekly review - Audio playing'), apps)[0]
    const session = new MeetingSession()
    session.observe(0, [candidate])
    expect(session.observe(91_000, [{ ...candidate, remoteAudio: false }])).toEqual([])
  })
})
