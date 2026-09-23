// ─────────────────────────────────────────────────────────────────────────────
// Meeting detection: which mic-holding processes are in a meeting right now. Pure: the helper's
// mic-session snapshot plus one probe (windows, browser tabs, render meters) in, candidates out.
// The rules and the title samples behind them are in
// docs/superpowers/specs/2026-09-22-meeting-notes-design.md (Detection).
// ─────────────────────────────────────────────────────────────────────────────

import type {
  HelperBrowserTab,
  HelperWindow,
  MeetingAppId,
  MeetingAppToggles,
  MeetingCandidate,
  MicSession,
  ProbeResult,
  RenderSession
} from './meeting-types'
import type { MeetingContinuation } from './meeting-session'

/** A render meter peak at or above this means the far end is audible (lobbies stay at 0.000). */
export const REMOTE_AUDIO_PEAK = 0.003

export const BROWSER_EXES: readonly string[] = [
  'chrome.exe',
  'msedge.exe',
  'brave.exe',
  'firefox.exe',
  'arc.exe',
  'vivaldi.exe',
  'opera.exe'
]

const NATIVE_EXES: Record<Exclude<MeetingAppId, 'google-meet'>, readonly string[]> = {
  teams: ['ms-teams.exe', 'teams.exe'],
  slack: ['slack.exe'],
  zoom: ['zoom.exe'],
  webex: ['ciscocollabhost.exe', 'webexmta.exe', 'atmgr.exe', 'webex.exe']
}

/** Apps that can run in a browser tab. */
const BROWSER_APPS: readonly MeetingAppId[] = ['google-meet', 'teams', 'slack', 'zoom']

export function meetingAppFor(s: Pick<MicSession, 'exe' | 'packageFamily'>): MeetingAppId | 'browser' | null {
  const exe = s.exe.toLowerCase()
  const family = (s.packageFamily ?? '').toLowerCase()
  if (family === 'msteams_8wekyb3d8bbwe') return 'teams'
  if (family.startsWith('com.tinyspeck.slackdesktop_')) return 'slack'
  if (BROWSER_EXES.includes(exe)) return 'browser'
  for (const [app, exes] of Object.entries(NATIVE_EXES) as Array<[MeetingAppId, readonly string[]]>) {
    if (exes.includes(exe)) return app
  }
  return null
}

function probeWorthy(app: MeetingAppId | 'browser' | null, apps: MeetingAppToggles): boolean {
  if (app === null) return false
  if (app === 'browser') return BROWSER_APPS.some((a) => apps[a])
  return apps[app]
}

/** Lower-case exes to probe; empty while no enabled meeting app holds the mic. */
export function probeExesFor(sessions: MicSession[], apps: MeetingAppToggles): string[] {
  const exes: string[] = []
  for (const s of sessions) {
    const exe = s.exe.toLowerCase()
    if (!exes.includes(exe) && probeWorthy(meetingAppFor(s), apps)) exes.push(exe)
  }
  return exes
}

// ── Titles ────────────────────────────────────────────────────────────────────

// Zero-width and bidi embedding/isolate marks. Chrome wraps titles in U+202A/U+202C on RTL-locale
// machines, and Edge writes "Microsoft​Edge".
const FORMAT_MARKS = /[​-‏‪-‮⁦-⁩]/g

// Chromium appends the tab's highest-priority alert to its accessible name. Only the English
// strings are matched; a localised browser falls back to window titles.
const ALERT_SUFFIX = / [-–—] (Microphone recording|Camera and microphone recording|Camera recording|Audio playing)$/

// Firefox separates with an em dash ('<page> — Mozilla Firefox').
const BROWSER_NAME = /^(?:Google Chrome|Chromium|Microsoft ?Edge|Brave|Mozilla Firefox|Firefox|Arc|Vivaldi|Opera)$/
const BROWSER_SUFFIX =
  / [-–—] (?:Google Chrome|Chromium|Microsoft ?Edge|Brave|Mozilla Firefox|Firefox|Arc|Vivaldi|Opera)$/

// Edge: '<tab> and 3 more pages - <Profile>' once the browser name is gone.
const MORE_PAGES = / and \d+ more pages?(?: [-–—] .*)?$/

function clean(text: string): string {
  return text.replace(FORMAT_MARKS, '').trim()
}

/** The tab or window name without alert and browser suffixes; which alert it carried. */
function stripSuffixes(text: string): { name: string; recording: boolean; audible: boolean } {
  let name = clean(text)
  let recording = false
  let audible = false
  for (let m = ALERT_SUFFIX.exec(name); m; m = ALERT_SUFFIX.exec(name)) {
    if (m[1] === 'Audio playing') audible = true
    else if (m[1] !== 'Camera recording') recording = true
    name = name.slice(0, m.index)
  }
  name = name.replace(BROWSER_SUFFIX, '').replace(MORE_PAGES, '').trim()
  return { name, recording, audible }
}

/** The meeting code or title of a Meet tab/window, or null (loading page, landing page, other). */
export function parseMeetTitle(text: string): string | null {
  // The code never contains ' - '; anything after one is an Edge profile name.
  const match = /^Meet [-–] (.+?)(?: [-–—] .*)?$/.exec(stripSuffixes(text).name)
  const title = match?.[1].trim()
  // 'Meet - Google Chrome - Work' is the loading page with a profile name after it.
  return title && !BROWSER_NAME.test(title) ? title : null
}

const TEAMS_SECTIONS = new Set(['Meet', 'Chat', 'Activity', 'Calendar', 'Teams', 'Calls', 'OneDrive', 'Apps', 'Copilot'])

function isTeamsTitle(name: string): boolean {
  return /\|\s*Microsoft Teams\b/.test(name)
}

/** A Teams meeting window's title and the other party's name, or null for main/utility windows. */
export function parseTeamsTitle(text: string): { title: string; nameHint: string | null } | null {
  const match = /^(.*?)\s*\|\s*Microsoft Teams\b/.exec(stripSuffixes(text).name)
  if (!match) return null
  const title = match[1].trim()
  const first = title.split('|')[0].trim()
  if (!title || TEAMS_SECTIONS.has(first)) return null
  const hint = /^Meeting with (.+)$/.exec(title)?.[1].trim()
  return { title, nameHint: hint ? hint : null }
}

function isSlackTitle(name: string): boolean {
  return name.split(/ [-–] /).some((part) => /^Slack(?:$|[\s[])/.test(part))
}

/** The conversation Slack's main window shows: a DM partner (with a name hint) or a #channel. */
export function parseSlackTitle(text: string): { title: string; nameHint: string | null } | null {
  const name = stripSuffixes(text).name
  if (!isSlackTitle(name)) return null
  const conversation = name.replace(/^!\s*/, '').split(/ [-–] /)[0].trim()
  const dm = /^(.+?)\s*\(DM\)$/.exec(conversation)
  if (dm) {
    const who = dm[1].trim()
    return { title: who, nameHint: who.includes(',') ? null : who }
  }
  if (/^#\S+$/.test(conversation)) return { title: conversation, nameHint: null }
  return null
}

// ── Candidates ────────────────────────────────────────────────────────────────

interface Evidence {
  app: MeetingAppId
  title: string | null
  nameHints: string[]
}

/** Items of the app process: those rooted at `appPid`, else any with the same exe. */
function ownedBy<T extends { appPid: number; exe: string }>(items: T[], appPid: number, exe: string): T[] {
  const byPid = items.filter((i) => i.appPid === appPid)
  return byPid.length > 0 ? byPid : items.filter((i) => i.exe.toLowerCase() === exe)
}

function browserEvidence(tabs: HelperBrowserTab[], windows: HelperWindow[]): Evidence[] {
  const found: Evidence[] = []
  const add = (e: Evidence): void => {
    if (!found.some((f) => f.app === e.app)) found.push(e)
  }
  const recordingTabs = tabs.map((t) => stripSuffixes(t.name)).filter((t) => t.recording)
  for (const t of recordingTabs) {
    const meet = parseMeetTitle(t.name)
    if (meet) {
      add({ app: 'google-meet', title: meet, nameHints: [] })
    } else if (isTeamsTitle(t.name)) {
      const teams = parseTeamsTitle(t.name)
      add({ app: 'teams', title: teams?.title ?? null, nameHints: teams?.nameHint ? [teams.nameHint] : [] })
    } else if (isSlackTitle(t.name)) {
      const slack = parseSlackTitle(t.name)
      add({ app: 'slack', title: slack?.title ?? null, nameHints: slack?.nameHint ? [slack.nameHint] : [] })
    } else if (/\bZoom\b/i.test(t.name)) {
      add({ app: 'zoom', title: null, nameHints: [] })
    }
  }
  // A tab that holds the mic but names no meeting (voice notes, ChatGPT) settles it: not a meeting.
  // Only without such a tab (no tab data, Firefox, a non-English suffix) do window titles count.
  if (recordingTabs.length > 0) return found
  for (const w of windows) {
    const meet = parseMeetTitle(w.title)
    if (meet) {
      add({ app: 'google-meet', title: meet, nameHints: [] })
      continue
    }
    const teams = parseTeamsTitle(w.title)
    if (teams) add({ app: 'teams', title: teams.title, nameHints: teams.nameHint ? [teams.nameHint] : [] })
  }
  return found
}

function nativeEvidence(app: MeetingAppId, appPid: number, exe: string, probe: ProbeResult | null): Evidence | null {
  if (app === 'teams' || app === 'slack') {
    // The mic alone means a call: neither app captures outside calls, huddles and clips.
    if (!probe) return { app, title: null, nameHints: [] }
    const parse = app === 'teams' ? parseTeamsTitle : parseSlackTitle
    for (const w of ownedBy(probe.windows, appPid, exe)) {
      const parsed = parse(w.title)
      if (parsed) return { app, title: parsed.title, nameHints: parsed.nameHint ? [parsed.nameHint] : [] }
    }
    return { app, title: null, nameHints: [] }
  }
  if (!probe) return null
  // Zoom's meeting window lives in a different Zoom.exe process than its main window, and Webex
  // spreads a meeting across several executables, so these match on the whole app.
  const family = NATIVE_EXES[app as 'zoom' | 'webex']
  const windows = probe.windows.filter((w) => family.includes(w.exe.toLowerCase()))
  const inMeeting =
    app === 'zoom'
      ? windows.some((w) => clean(w.title) === 'Zoom Meeting' || w.className === 'ZPContentViewWndClass')
      : windows.some((w) => clean(w.title).includes('Meeting'))
  return inMeeting ? { app, title: null, nameHints: [] } : null
}

function renderOf(render: RenderSession[], appPid: number, exes: readonly string[]): RenderSession[] {
  return render.filter((r) => r.appPid === appPid || exes.includes(r.exe.toLowerCase()))
}

function uniqueSorted(pids: number[]): number[] {
  return [...new Set(pids)].sort((a, b) => a - b)
}

export function detectMeetings(
  sessions: MicSession[],
  probe: ProbeResult | null,
  apps: MeetingAppToggles
): MeetingCandidate[] {
  // Group mic sessions by app process; the first session of each supplies the microphone.
  const groups = new Map<string, { kind: MeetingAppId | 'browser'; first: MicSession; exe: string }>()
  for (const s of sessions) {
    const kind = meetingAppFor(s)
    if (!kind) continue
    const id = `${kind}:${s.appPid}`
    if (!groups.has(id)) groups.set(id, { kind, first: s, exe: s.exe.toLowerCase() })
  }

  const candidates = new Map<string, MeetingCandidate>()
  for (const { kind, first, exe } of groups.values()) {
    const appPid = first.appPid
    let evidence: Evidence[]
    if (kind === 'browser') {
      evidence = probe ? browserEvidence(ownedBy(probe.tabs, appPid, exe), ownedBy(probe.windows, appPid, exe)) : []
    } else {
      const e = nativeEvidence(kind, appPid, exe, probe)
      evidence = e ? [e] : []
    }

    const exes = kind === 'browser' ? [exe] : NATIVE_EXES[kind as keyof typeof NATIVE_EXES]
    const render = probe ? renderOf(probe.render, appPid, exes) : []
    const active = render.filter((r) => r.active)
    const otherPids = uniqueSorted(
      active.length > 0 ? active.map((r) => r.pid) : render.length > 0 ? render.map((r) => r.pid) : [appPid]
    )
    const remoteAudio = render.some((r) => r.peak >= REMOTE_AUDIO_PEAK)

    for (const e of evidence) {
      if (!apps[e.app]) continue
      const key = `${e.app}:${appPid}`
      if (candidates.has(key)) continue
      candidates.set(key, {
        key,
        app: e.app,
        viaBrowser: kind === 'browser',
        title: e.title,
        appPid,
        exe,
        micEndpointId: first.endpointId,
        otherPids: [...otherPids],
        remoteAudio,
        nameHints: e.nameHints
      })
    }
  }
  return [...candidates.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

// ── Continuation while recording ─────────────────────────────────────────────────

/** The executables to keep probing while `c` is recorded, even after its mic session is gone. */
export function candidateExes(c: MeetingCandidate): string[] {
  if (c.viaBrowser) return [c.exe.toLowerCase()]
  return [...NATIVE_EXES[c.app as keyof typeof NATIVE_EXES]]
}

/** Does this tab or window name show the recorded app's meeting? */
function showsMeeting(app: MeetingAppId, text: string): boolean {
  const { name } = stripSuffixes(text)
  if (app === 'google-meet') return parseMeetTitle(name) !== null
  if (app === 'teams') return parseTeamsTitle(name) !== null
  if (app === 'zoom') return /\bZoom\b/i.test(name)
  return false
}

/**
 * Evidence that the recorded meeting is still on while its app holds no mic session (some apps
 * release the mic on mute). `evidence`: the meeting's tab or window still exists; Slack shows none,
 * so for it only remote audio counts (the session requires recent remote audio either way).
 * `remoteAudio`: the far end is audible now. In a browser, the meeting tab's own "Audio playing"
 * alert decides; the browser's render meter counts only when no other tab is the one playing, so
 * a video in another tab cannot keep a lingering meeting tab recording.
 */
export function continuationEvidence(c: MeetingCandidate, probe: ProbeResult | null): MeetingContinuation | null {
  const slack = c.app === 'slack'
  // No probe result: unknown, which the session treats with the usual end grace.
  if (!probe) return null
  const exes = candidateExes(c)
  const loud = renderOf(probe.render, c.appPid, exes).some((r) => r.peak >= REMOTE_AUDIO_PEAK)

  if (c.viaBrowser) {
    const tabs = probe.tabs.filter((t) => t.appPid === c.appPid)
    const meetingTabs = tabs.filter((t) => showsMeeting(c.app, t.name))
    const windows = probe.windows.filter((w) => w.appPid === c.appPid)
    const evidence = slack || meetingTabs.length > 0 || (tabs.length === 0 && windows.some((w) => showsMeeting(c.app, w.title)))
    // Slack has no tab evidence to tell its huddle tab from others, so its meter decides alone.
    if (slack) return { evidence, remoteAudio: loud, audioOnly: true }
    const meetingAudible = meetingTabs.some((t) => stripSuffixes(t.name).audible)
    const otherAudible = tabs.some((t) => !meetingTabs.includes(t) && stripSuffixes(t.name).audible)
    return { evidence, remoteAudio: meetingAudible || (loud && !otherAudible) }
  }

  const windows = probe.windows.filter((w) => exes.includes(w.exe.toLowerCase()))
  let evidence = slack
  if (c.app === 'teams') evidence = windows.some((w) => parseTeamsTitle(w.title) !== null)
  else if (c.app === 'zoom') evidence = windows.some((w) => clean(w.title) === 'Zoom Meeting' || w.className === 'ZPContentViewWndClass')
  else if (c.app === 'webex') evidence = windows.some((w) => clean(w.title).includes('Meeting'))
  // Slack shows no huddle window: its evidence is assumed, so only its sound keeps a call going.
  return slack ? { evidence, remoteAudio: loud, audioOnly: true } : { evidence, remoteAudio: loud }
}
