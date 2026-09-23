import { describe, it, expect } from 'vitest'
import {
  BROWSER_EXES,
  REMOTE_AUDIO_PEAK,
  candidateExes,
  continuationEvidence,
  detectMeetings,
  meetingAppFor,
  parseMeetTitle,
  parseSlackTitle,
  parseTeamsTitle,
  probeExesFor
} from '@shared/meeting-detect'
import type {
  HelperBrowserTab,
  HelperWindow,
  MeetingAppToggles,
  MeetingCandidate,
  MicSession,
  ProbeResult,
  RenderSession
} from '@shared/meeting-types'

const ALL_ON: MeetingAppToggles = { 'google-meet': true, teams: true, slack: true, zoom: true, webex: true }

function mic(exe: string, appPid: number, extra: Partial<MicSession> = {}): MicSession {
  return {
    pid: appPid + 1,
    appPid,
    exe,
    path: `C:\\Apps\\${exe}`,
    packageFamily: null,
    endpointId: `{mic-${appPid}}`,
    endpointName: 'Headset Microphone',
    ...extra
  }
}

function win(exe: string, appPid: number, title: string, className = 'Chrome_WidgetWin_1'): HelperWindow {
  return { pid: appPid, appPid, exe, title, className, minimized: false }
}

function tab(exe: string, appPid: number, name: string): HelperBrowserTab {
  return { appPid, exe, name }
}

function render(exe: string, appPid: number, pid: number, extra: Partial<RenderSession> = {}): RenderSession {
  return { pid, appPid, exe, endpointId: '{speakers}', active: true, peak: 0, ...extra }
}

function probe(p: Partial<ProbeResult> = {}): ProbeResult {
  return { windows: [], tabs: [], render: [], ...p }
}

describe('meetingAppFor', () => {
  it('maps native meeting apps by exe and package family', () => {
    expect(meetingAppFor({ exe: 'ms-teams.exe', packageFamily: 'MSTeams_8wekyb3d8bbwe' })).toBe('teams')
    expect(meetingAppFor({ exe: 'whatever.exe', packageFamily: 'MSTeams_8wekyb3d8bbwe' })).toBe('teams')
    expect(meetingAppFor({ exe: 'Teams.exe', packageFamily: null })).toBe('teams')
    expect(meetingAppFor({ exe: 'slack.exe', packageFamily: null })).toBe('slack')
    expect(meetingAppFor({ exe: 'app.exe', packageFamily: 'com.tinyspeck.slackdesktop_8yrtsj140pw4g' })).toBe('slack')
    expect(meetingAppFor({ exe: 'Zoom.exe', packageFamily: null })).toBe('zoom')
    for (const exe of ['ciscocollabhost.exe', 'webexmta.exe', 'atmgr.exe', 'webex.exe']) {
      expect(meetingAppFor({ exe, packageFamily: null })).toBe('webex')
    }
  })

  it('maps every browser to browser and anything else to null', () => {
    for (const exe of BROWSER_EXES) expect(meetingAppFor({ exe, packageFamily: null })).toBe('browser')
    expect(BROWSER_EXES).toEqual(
      expect.arrayContaining(['chrome.exe', 'msedge.exe', 'brave.exe', 'firefox.exe', 'arc.exe', 'vivaldi.exe', 'opera.exe'])
    )
    expect(meetingAppFor({ exe: 'discord.exe', packageFamily: null })).toBeNull()
    expect(meetingAppFor({ exe: 'obs64.exe', packageFamily: null })).toBeNull()
  })
})

describe('probeExesFor', () => {
  it('returns nothing when no mic session belongs to a meeting app', () => {
    expect(probeExesFor([], ALL_ON)).toEqual([])
    expect(probeExesFor([mic('discord.exe', 10), mic('obs64.exe', 20)], ALL_ON)).toEqual([])
  })

  it('returns lower-case, deduped exes in first-seen order', () => {
    const sessions = [mic('Chrome.exe', 1), mic('discord.exe', 2), mic('ms-teams.exe', 3), mic('chrome.exe', 1)]
    expect(probeExesFor(sessions, ALL_ON)).toEqual(['chrome.exe', 'ms-teams.exe'])
  })

  it('skips disabled apps, and browsers once every browser-hosted app is disabled', () => {
    const sessions = [mic('chrome.exe', 1), mic('slack.exe', 2)]
    expect(probeExesFor(sessions, { ...ALL_ON, slack: false })).toEqual(['chrome.exe'])
    expect(
      probeExesFor(sessions, { 'google-meet': false, teams: false, slack: true, zoom: false, webex: true })
    ).toEqual(['chrome.exe', 'slack.exe'])
    expect(
      probeExesFor(sessions, { 'google-meet': false, teams: false, slack: false, zoom: false, webex: true })
    ).toEqual([])
  })
})

describe('title parsing', () => {
  it('parses Meet tab names and window titles', () => {
    expect(parseMeetTitle('Meet - abc-defg-hij - Microphone recording')).toBe('abc-defg-hij')
    expect(parseMeetTitle('Meet - abc-defg-hij - Camera and microphone recording')).toBe('abc-defg-hij')
    expect(parseMeetTitle('Meet - abc-defg-hij - Google Chrome')).toBe('abc-defg-hij')
    expect(parseMeetTitle('Meet - abc-defg-hij')).toBe('abc-defg-hij')
    expect(parseMeetTitle('Meet – Weekly sync')).toBe('Weekly sync')
    expect(parseMeetTitle('Meet - abc-defg-hij and 3 more pages - Work - Microsoft\u200b Edge')).toBe('abc-defg-hij')
  })

  it('rejects the loading title and the landing page', () => {
    expect(parseMeetTitle('Meet - Google Chrome')).toBeNull()
    expect(parseMeetTitle('Google Meet - Google Chrome')).toBeNull()
    expect(parseMeetTitle('Google Meet')).toBeNull()
    expect(parseMeetTitle('Meet')).toBeNull()
    expect(parseMeetTitle('Inbox - Gmail - Google Chrome')).toBeNull()
  })

  it('strips bidi and zero-width marks before matching', () => {
    expect(parseMeetTitle('\u202aMeet - abc-defg-hij\u202c - Google Chrome')).toBe('abc-defg-hij')
    expect(parseMeetTitle('\u2066Meet - abc-defg-hij\u2069 - Microsoft\u200b Edge')).toBe('abc-defg-hij')
    expect(parseTeamsTitle('\u202aMeeting with Blake Whitmore | Microsoft Teams\u202c')).toEqual({
      title: 'Meeting with Blake Whitmore',
      nameHint: 'Blake Whitmore'
    })
  })

  it('parses Teams meeting titles and ignores utility and section windows', () => {
    expect(parseTeamsTitle('Meeting with Blake Whitmore | Microsoft Teams')).toEqual({
      title: 'Meeting with Blake Whitmore',
      nameHint: 'Blake Whitmore'
    })
    expect(parseTeamsTitle('Weekly Zac | Microsoft Teams')).toEqual({ title: 'Weekly Zac', nameHint: null })
    expect(parseTeamsTitle('Meet | Microsoft Teams')).toBeNull()
    expect(parseTeamsTitle('Microsoft Teams')).toBeNull()
    for (const section of ['Chat', 'Activity', 'Calendar', 'Teams', 'Calls', 'OneDrive', 'Apps', 'Copilot']) {
      expect(parseTeamsTitle(`${section} | Blake Whitmore | Microsoft Teams`)).toBeNull()
    }
    expect(parseTeamsTitle('Inbox - Outlook')).toBeNull()
  })

  it('parses a Teams web title behind a browser suffix', () => {
    expect(parseTeamsTitle('Weekly Zac | Microsoft Teams - Google Chrome')).toEqual({
      title: 'Weekly Zac',
      nameHint: null
    })
  })

  it('parses Slack DM and channel titles', () => {
    expect(parseSlackTitle('! Blake Whitmore (DM) - Acme - 1 new item - Slack')).toEqual({
      title: 'Blake Whitmore',
      nameHint: 'Blake Whitmore'
    })
    expect(parseSlackTitle('Blake Whitmore (DM) - Acme - Slack')).toEqual({
      title: 'Blake Whitmore',
      nameHint: 'Blake Whitmore'
    })
    expect(parseSlackTitle('Blake Whitmore (DM) - Acme - 3 new items - Slack [Main] \u{1f3e0}\u{1f50a}')).toEqual({
      title: 'Blake Whitmore',
      nameHint: 'Blake Whitmore'
    })
    expect(parseSlackTitle('#eng-standup - Acme - Slack')).toEqual({ title: '#eng-standup', nameHint: null })
  })

  it('gives a group DM no name hint', () => {
    expect(parseSlackTitle('Alice Smith, Bob Jones (DM) - Acme - Slack')).toEqual({
      title: 'Alice Smith, Bob Jones',
      nameHint: null
    })
  })

  it('rejects titles that are not Slack conversations', () => {
    expect(parseSlackTitle('Slack')).toBeNull()
    expect(parseSlackTitle('Activity - Acme - Slack')).toBeNull()
    expect(parseSlackTitle('Blake Whitmore (DM) - Acme - Google Chrome')).toBeNull()
  })
})

describe('detectMeetings: browsers', () => {
  const chromeMic = mic('chrome.exe', 100)

  it('detects a Meet tab that is recording, even in the background', () => {
    const p = probe({
      windows: [win('chrome.exe', 100, 'Inbox - Gmail - Google Chrome')],
      tabs: [tab('chrome.exe', 100, 'Inbox - Gmail'), tab('chrome.exe', 100, 'Meet - abc-defg-hij - Microphone recording')],
      render: [render('chrome.exe', 100, 140, { peak: 0.2 })]
    })
    expect(detectMeetings([chromeMic], p, ALL_ON)).toEqual([
      {
        key: 'google-meet:100',
        app: 'google-meet',
        viaBrowser: true,
        title: 'abc-defg-hij',
        appPid: 100,
        exe: 'chrome.exe',
        micEndpointId: '{mic-100}',
        otherPids: [140],
        remoteAudio: true,
        nameHints: []
      }
    ])
  })

  it('never treats a browser capturing without a meeting tab as a meeting', () => {
    const p = probe({
      windows: [win('chrome.exe', 100, 'ChatGPT - Google Chrome')],
      tabs: [tab('chrome.exe', 100, 'ChatGPT - Microphone recording'), tab('chrome.exe', 100, 'Google Meet')],
      render: [render('chrome.exe', 100, 140, { peak: 0.4 })]
    })
    expect(detectMeetings([chromeMic], p, ALL_ON)).toEqual([])
  })

  it('does not fall back to a Meet window title when another tab holds the mic', () => {
    const p = probe({
      windows: [win('chrome.exe', 100, 'Meet - abc-defg-hij - Google Chrome')],
      tabs: [tab('chrome.exe', 100, 'Voice notes - Microphone recording'), tab('chrome.exe', 100, 'Meet - abc-defg-hij')]
    })
    expect(detectMeetings([chromeMic], p, ALL_ON)).toEqual([])
  })

  it('ignores Meet tabs that are recording but still loading or on the landing page', () => {
    for (const name of ['Meet - Microphone recording', 'Google Meet - Microphone recording']) {
      const p = probe({ tabs: [tab('chrome.exe', 100, name)] })
      expect(detectMeetings([chromeMic], p, ALL_ON)).toEqual([])
    }
  })

  it('falls back to window titles when there is no tab data', () => {
    const p = probe({ windows: [win('msedge.exe', 200, 'Meet - abc-defg-hij and 2 more pages - Work - Microsoft\u200b Edge')] })
    const [c] = detectMeetings([mic('msedge.exe', 200)], p, ALL_ON)
    expect(c).toMatchObject({ key: 'google-meet:200', title: 'abc-defg-hij', viaBrowser: true, exe: 'msedge.exe' })
  })

  it('does not accept the loading or landing window title as fallback evidence', () => {
    for (const title of ['Meet - Google Chrome', 'Google Meet - Google Chrome']) {
      const p = probe({ windows: [win('chrome.exe', 100, title)] })
      expect(detectMeetings([chromeMic], p, ALL_ON)).toEqual([])
    }
  })

  it('detects Teams, Slack and Zoom web meetings from a recording tab', () => {
    const cases: Array<[string, string, string | null]> = [
      ['Meeting with Blake Whitmore | Microsoft Teams - Camera and microphone recording', 'teams', 'Meeting with Blake Whitmore'],
      ['Calendar | Calendar | Microsoft Teams - Microphone recording', 'teams', null],
      ['Blake Whitmore (DM) - Acme - Slack - Microphone recording', 'slack', 'Blake Whitmore'],
      ['Zoom Meeting - Microphone recording', 'zoom', null]
    ]
    for (const [name, app, title] of cases) {
      const [c] = detectMeetings([chromeMic], probe({ tabs: [tab('chrome.exe', 100, name)] }), ALL_ON)
      expect(c).toMatchObject({ key: `${app}:100`, app, viaBrowser: true, title })
    }
  })

  it('carries the Teams web meeting name hint', () => {
    const p = probe({ tabs: [tab('chrome.exe', 100, 'Meeting with Blake Whitmore | Microsoft Teams - Microphone recording')] })
    expect(detectMeetings([chromeMic], p, ALL_ON)[0].nameHints).toEqual(['Blake Whitmore'])
  })

  it('matches tabs by appPid, falling back to exe', () => {
    const other = probe({
      tabs: [
        tab('chrome.exe', 999, 'Meet - zzz-zzzz-zzz - Microphone recording'),
        tab('chrome.exe', 100, 'Docs - Microphone recording')
      ]
    })
    expect(detectMeetings([chromeMic], other, ALL_ON)).toEqual([])
    const byExe = probe({ tabs: [tab('chrome.exe', 999, 'Meet - zzz-zzzz-zzz - Microphone recording')] })
    expect(detectMeetings([chromeMic], byExe, ALL_ON)[0]).toMatchObject({ key: 'google-meet:100', title: 'zzz-zzzz-zzz' })
  })

  it('never yields a candidate for a disabled app', () => {
    const p = probe({ tabs: [tab('chrome.exe', 100, 'Meet - abc-defg-hij - Microphone recording')] })
    expect(detectMeetings([chromeMic], p, { ...ALL_ON, 'google-meet': false })).toEqual([])
  })
})

describe('detectMeetings: Teams desktop', () => {
  const teams = mic('ms-teams.exe', 300, { packageFamily: 'MSTeams_8wekyb3d8bbwe' })

  it('makes a candidate from the mic alone, skipping the utility and main windows for the title', () => {
    const p = probe({
      windows: [
        win('ms-teams.exe', 300, 'Meet | Microsoft Teams', 'TeamsWebView'),
        win('ms-teams.exe', 300, 'Microsoft Teams', 'TeamsWebView'),
        win('ms-teams.exe', 300, 'Chat | Blake Whitmore | Microsoft Teams', 'TeamsWebView'),
        win('ms-teams.exe', 300, 'Meeting with Blake Whitmore | Microsoft Teams', 'TeamsWebView')
      ]
    })
    expect(detectMeetings([teams], p, ALL_ON)).toEqual([
      expect.objectContaining({
        key: 'teams:300',
        app: 'teams',
        viaBrowser: false,
        title: 'Meeting with Blake Whitmore',
        nameHints: ['Blake Whitmore']
      })
    ])
  })

  it('never takes the always-present utility window as the title', () => {
    const p = probe({
      windows: [
        win('ms-teams.exe', 300, 'Meet | Microsoft Teams', 'TeamsWebView'),
        win('ms-teams.exe', 300, 'Activity | Microsoft Teams', 'TeamsWebView')
      ]
    })
    expect(detectMeetings([teams], p, ALL_ON)[0]).toMatchObject({ key: 'teams:300', title: null, nameHints: [] })
  })

  it('yields mic-alone candidates without a probe', () => {
    expect(detectMeetings([teams, mic('slack.exe', 400), mic('zoom.exe', 500)], null, ALL_ON)).toEqual([
      {
        key: 'slack:400',
        app: 'slack',
        viaBrowser: false,
        title: null,
        appPid: 400,
        exe: 'slack.exe',
        micEndpointId: '{mic-400}',
        otherPids: [400],
        remoteAudio: false,
        nameHints: []
      },
      {
        key: 'teams:300',
        app: 'teams',
        viaBrowser: false,
        title: null,
        appPid: 300,
        exe: 'ms-teams.exe',
        micEndpointId: '{mic-300}',
        otherPids: [300],
        remoteAudio: false,
        nameHints: []
      }
    ])
  })
})

describe('detectMeetings: Slack, Zoom, Webex', () => {
  it('takes the Slack DM partner as title and name hint', () => {
    const p = probe({ windows: [win('slack.exe', 400, '! Blake Whitmore (DM) - Acme - 1 new item - Slack')] })
    expect(detectMeetings([mic('slack.exe', 400)], p, ALL_ON)[0]).toMatchObject({
      key: 'slack:400',
      title: 'Blake Whitmore',
      nameHints: ['Blake Whitmore']
    })
  })

  it('titles a Slack channel huddle without a hint', () => {
    const p = probe({ windows: [win('slack.exe', 400, '#eng - Acme - Slack')] })
    expect(detectMeetings([mic('slack.exe', 400)], p, ALL_ON)[0]).toMatchObject({ title: '#eng', nameHints: [] })
  })

  it('needs a Zoom Meeting window', () => {
    const zoom = mic('zoom.exe', 500)
    expect(detectMeetings([zoom], probe({ windows: [win('zoom.exe', 500, 'Zoom Workplace')] }), ALL_ON)).toEqual([])
    expect(detectMeetings([zoom], null, ALL_ON)).toEqual([])
    // The meeting window belongs to a different Zoom.exe process than the one holding the mic.
    const byTitle = probe({ windows: [win('zoom.exe', 500, 'Zoom Workplace'), win('zoom.exe', 510, 'Zoom Meeting')] })
    expect(detectMeetings([zoom], byTitle, ALL_ON)[0]).toMatchObject({ key: 'zoom:500', app: 'zoom', title: null })
    const byClass = probe({ windows: [win('zoom.exe', 510, '', 'ZPContentViewWndClass')] })
    expect(detectMeetings([zoom], byClass, ALL_ON)).toHaveLength(1)
  })

  it('needs a Webex window whose title contains Meeting', () => {
    const webex = mic('ciscocollabhost.exe', 600)
    expect(detectMeetings([webex], probe({ windows: [win('ciscocollabhost.exe', 600, 'Webex')] }), ALL_ON)).toEqual([])
    const p = probe({ windows: [win('atmgr.exe', 610, 'Personal Room Meeting')] })
    expect(detectMeetings([webex], p, ALL_ON)[0]).toMatchObject({ key: 'webex:600', app: 'webex' })
  })
})

describe('detectMeetings: audio routing', () => {
  const teams = mic('ms-teams.exe', 300)

  it('uses the active render sessions of the app, sorted and deduped', () => {
    const p = probe({
      render: [
        render('ms-teams.exe', 300, 330),
        render('ms-teams.exe', 300, 310),
        render('ms-teams.exe', 300, 330),
        render('ms-teams.exe', 300, 320, { active: false }),
        render('chrome.exe', 100, 140)
      ]
    })
    expect(detectMeetings([teams], p, ALL_ON)[0].otherPids).toEqual([310, 330])
  })

  it('falls back to all render sessions, then to the app pid', () => {
    const inactive = probe({ render: [render('ms-teams.exe', 300, 320, { active: false })] })
    expect(detectMeetings([teams], inactive, ALL_ON)[0].otherPids).toEqual([320])
    expect(detectMeetings([teams], probe(), ALL_ON)[0].otherPids).toEqual([300])
  })

  it('matches render sessions by exe when the root pid differs', () => {
    const p = probe({ render: [render('ms-teams.exe', 399, 350)] })
    expect(detectMeetings([teams], p, ALL_ON)[0].otherPids).toEqual([350])
  })

  it('hears remote audio at the peak threshold, not below', () => {
    const below = probe({ render: [render('ms-teams.exe', 300, 310, { peak: REMOTE_AUDIO_PEAK / 2 })] })
    expect(detectMeetings([teams], below, ALL_ON)[0].remoteAudio).toBe(false)
    const at = probe({ render: [render('ms-teams.exe', 300, 310, { peak: REMOTE_AUDIO_PEAK })] })
    expect(detectMeetings([teams], at, ALL_ON)[0].remoteAudio).toBe(true)
    expect(REMOTE_AUDIO_PEAK).toBe(0.003)
  })

  it('makes one candidate per app process, with the first session’s mic, sorted by key', () => {
    const sessions = [
      mic('ms-teams.exe', 300, { endpointId: '{first}' }),
      mic('ms-teams.exe', 300, { pid: 305, endpointId: '{second}' }),
      mic('ms-teams.exe', 20)
    ]
    const candidates = detectMeetings(sessions, probe(), ALL_ON)
    expect(candidates.map((c) => c.key)).toEqual(['teams:20', 'teams:300'])
    expect(candidates[1].micEndpointId).toBe('{first}')
  })
})

describe('continuationEvidence (recording, the app holds no mic session)', () => {
  function recorded(app: MeetingCandidate['app'], exe: string, appPid: number, viaBrowser = false): MeetingCandidate {
    return {
      key: `${app}:${appPid}`,
      app,
      viaBrowser,
      title: null,
      appPid,
      exe,
      micEndpointId: '{mic}',
      otherPids: [appPid],
      remoteAudio: false,
      nameHints: []
    }
  }
  const meet = recorded('google-meet', 'chrome.exe', 100, true)
  const loud = { peak: 0.05 }

  it('Meet: the tab (any suffix) is evidence; its "Audio playing" suffix is remote audio', () => {
    expect(continuationEvidence(meet, probe({ tabs: [tab('chrome.exe', 100, 'Meet - abc-defg-hij - Audio playing')] }))).toEqual({
      evidence: true,
      remoteAudio: true
    })
    expect(continuationEvidence(meet, probe({ tabs: [tab('chrome.exe', 100, 'Meet - abc-defg-hij')] }))).toEqual({
      evidence: true,
      remoteAudio: false
    })
    expect(continuationEvidence(meet, probe({ tabs: [tab('chrome.exe', 100, 'Meet - abc-defg-hij - Camera recording')] }))?.evidence).toBe(true)
  })

  it('Meet: the browser render meter counts only when no other tab is the one playing', () => {
    const meetTab = tab('chrome.exe', 100, 'Meet - abc-defg-hij')
    const rendering = [render('chrome.exe', 100, 300, loud)]
    expect(continuationEvidence(meet, probe({ tabs: [meetTab], render: rendering }))?.remoteAudio).toBe(true)
    // A YouTube tab playing in the same browser must not keep a lingering Meet tab recording.
    const youtube = tab('chrome.exe', 100, 'Lo-fi beats - YouTube - Audio playing')
    expect(continuationEvidence(meet, probe({ tabs: [meetTab, youtube], render: rendering }))?.remoteAudio).toBe(false)
  })

  it('Meet: no evidence once the tab is closed, or for another browser process', () => {
    expect(continuationEvidence(meet, probe({ tabs: [tab('chrome.exe', 100, 'Inbox - Gmail')] }))?.evidence).toBe(false)
    expect(continuationEvidence(meet, probe({ tabs: [tab('chrome.exe', 999, 'Meet - abc-defg-hij')] }))?.evidence).toBe(false)
    expect(continuationEvidence(meet, probe({ tabs: [tab('chrome.exe', 100, 'Google Meet')] }))?.evidence).toBe(false)
  })

  it('Meet: falls back to the window title when the browser gives no tab data', () => {
    expect(continuationEvidence(meet, probe({ windows: [win('chrome.exe', 100, 'Meet - abc-defg-hij - Google Chrome')] }))?.evidence).toBe(true)
  })

  it('Teams: the meeting window, not the always-present utility window', () => {
    const teams = recorded('teams', 'ms-teams.exe', 300)
    const meeting = win('ms-teams.exe', 300, 'Weekly sync | Microsoft Teams', 'TeamsWebView')
    const utility = win('ms-teams.exe', 300, 'Meet | Microsoft Teams', 'TeamsWebView')
    expect(continuationEvidence(teams, probe({ windows: [utility, meeting], render: [render('ms-teams.exe', 300, 301, loud)] }))).toEqual({
      evidence: true,
      remoteAudio: true
    })
    expect(continuationEvidence(teams, probe({ windows: [utility] }))?.evidence).toBe(false)
  })

  it('Zoom: the Zoom Meeting window, from any Zoom process', () => {
    const zoom = recorded('zoom', 'zoom.exe', 500)
    expect(continuationEvidence(zoom, probe({ windows: [{ ...win('zoom.exe', 501, 'Zoom Meeting'), pid: 501 }] }))?.evidence).toBe(true)
    expect(continuationEvidence(zoom, probe({ windows: [win('zoom.exe', 500, 'Zoom Workplace')] }))?.evidence).toBe(false)
  })

  it('Slack: no window evidence exists, so only remote audio can keep it alive', () => {
    const slack = recorded('slack', 'slack.exe', 700)
    expect(continuationEvidence(slack, probe({ render: [render('slack.exe', 700, 700, loud)] }))).toEqual({
      evidence: true,
      remoteAudio: true,
      audioOnly: true
    })
    expect(continuationEvidence(slack, probe({ render: [render('slack.exe', 700, 700, { peak: REMOTE_AUDIO_PEAK / 2 })] }))?.remoteAudio).toBe(false)
    // Other apps have a window to check: their evidence is seen, not assumed.
    expect(continuationEvidence(recorded('teams', 'ms-teams.exe', 300), probe({}))?.audioOnly).toBeUndefined()
  })

  it('without a probe it cannot tell (null), so nothing is judged gone', () => {
    expect(continuationEvidence(meet, null)).toBeNull()
  })
})

describe('candidateExes', () => {
  it('is the browser for a browser meeting, else the app executables', () => {
    const base = { key: 'k', viaBrowser: false, title: null, appPid: 1, micEndpointId: null, otherPids: [], remoteAudio: false, nameHints: [] }
    expect(candidateExes({ ...base, app: 'google-meet', viaBrowser: true, exe: 'msedge.exe' })).toEqual(['msedge.exe'])
    expect(candidateExes({ ...base, app: 'teams', exe: 'ms-teams.exe' })).toEqual(['ms-teams.exe', 'teams.exe'])
    expect(candidateExes({ ...base, app: 'slack', viaBrowser: true, exe: 'chrome.exe' })).toEqual(['chrome.exe'])
  })
})

describe('review fixes', () => {
  it('strips the em-dash browser suffix Firefox uses', () => {
    expect(parseMeetTitle('Meet - abc-defg-hij — Mozilla Firefox')).toBe('abc-defg-hij')
  })

  it('never takes a browser name for a Meet title (loading page with a profile suffix)', () => {
    expect(parseMeetTitle('Meet - Google Chrome - Work')).toBeNull()
    expect(parseMeetTitle('Meet - Microsoft Edge')).toBeNull()
  })

  it('lets a Slack huddle in a browser continue on its own tab audio', () => {
    const slack = {
      key: 'slack:100',
      app: 'slack' as const,
      viaBrowser: true,
      title: null,
      appPid: 100,
      exe: 'chrome.exe',
      micEndpointId: null,
      otherPids: [100],
      remoteAudio: false,
      nameHints: []
    }
    const p = probe({
      tabs: [tab('chrome.exe', 100, 'Blake (DM) - Acme - Slack - Audio playing')],
      render: [render('chrome.exe', 100, 300, { peak: 0.05 })]
    })
    expect(continuationEvidence(slack, p)).toEqual({ evidence: true, remoteAudio: true, audioOnly: true })
  })
})
