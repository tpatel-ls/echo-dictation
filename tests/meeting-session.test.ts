import { describe, it, expect } from 'vitest'
import { DEFAULT_SESSION_CONFIG, MeetingSession } from '@shared/meeting-session'
import type { MeetingCandidate } from '@shared/meeting-types'

function cand(key: string, extra: Partial<MeetingCandidate> = {}): MeetingCandidate {
  const [app, pid] = key.split(':')
  return {
    key,
    app: app as MeetingCandidate['app'],
    viaBrowser: app === 'google-meet',
    title: null,
    appPid: Number(pid),
    exe: 'chrome.exe',
    micEndpointId: '{mic}',
    otherPids: [Number(pid)],
    remoteAudio: false,
    nameHints: [],
    ...extra
  }
}

const MEET = 'google-meet:100'
const TEAMS = 'teams:300'

/** Observe the same candidates every `step` ms over [from, to]; returns all actions with times. */
function run(s: MeetingSession, from: number, to: number, candidates: MeetingCandidate[], step = 1000) {
  const out: Array<{ at: number; action: unknown }> = []
  for (let t = from; t <= to; t += step) for (const action of s.observe(t, candidates)) out.push({ at: t, action })
  return out
}

/** A call whose far end is heard in two probes (0 s and 1.5 s) starts at 3 s. */
function startedSession(key = MEET): MeetingSession {
  const s = new MeetingSession()
  s.observe(0, [cand(key, { remoteAudio: true })])
  s.observe(1500, [cand(key, { remoteAudio: true })])
  expect(s.observe(3000, [cand(key)])).toEqual([{ type: 'start', candidate: cand(key) }])
  return s
}

describe('MeetingSession defaults', () => {
  it('uses the spec timings', () => {
    expect(DEFAULT_SESSION_CONFIG).toEqual({
      enabled: true,
      confirmAfterMs: 3000,
      aloneConfirmAfterMs: 90_000,
      endAfterMs: 15_000,
      maxDurationMs: 4 * 60 * 60 * 1000,
      forgetPendingAfterMs: 5000,
      continueWithoutMicMs: 60_000,
      endWhenGoneMs: 4000,
      remoteConfirmMinGapMs: 1000,
      remoteConfirmMaxGapMs: 6000
    })
  })
})

describe('MeetingSession: starting', () => {
  it('goes idle -> pending when a candidate appears', () => {
    const s = new MeetingSession()
    expect(s.state).toBe('idle')
    expect(s.current).toBeNull()
    expect(s.observe(0, [cand(MEET)])).toEqual([])
    expect(s.state).toBe('pending')
    expect(s.current?.key).toBe(MEET)
  })

  it('does not start a lobby (no remote audio) within 90 s, but starts at 90 s', () => {
    const s = new MeetingSession()
    const before = run(s, 0, 89_000, [cand(MEET)])
    expect(before).toEqual([])
    expect(s.state).toBe('pending')
    expect(s.observe(90_000, [cand(MEET)])).toEqual([{ type: 'start', candidate: cand(MEET) }])
    expect(s.state).toBe('recording')
  })

  it('starts 3 s after appearing once remote audio has been heard in two probes', () => {
    const s = new MeetingSession()
    expect(s.observe(0, [cand(MEET, { remoteAudio: true })])).toEqual([])
    expect(s.observe(1500, [cand(MEET, { remoteAudio: true })])).toEqual([])
    expect(s.observe(2999, [cand(MEET)])).toEqual([])
    // Remote audio is latched: it need not still be audible at the moment of starting.
    expect(s.observe(3000, [cand(MEET)])).toEqual([{ type: 'start', candidate: cand(MEET) }])
  })

  it('starts as soon as remote audio is sustained after a long lobby', () => {
    const s = new MeetingSession()
    expect(run(s, 0, 40_000, [cand(MEET)])).toEqual([])
    const withAudio = cand(MEET, { remoteAudio: true })
    expect(s.observe(41_000, [withAudio])).toEqual([])
    expect(s.observe(42_500, [withAudio])).toEqual([{ type: 'start', candidate: withAudio }])
  })

  it('does not open the gate on a single short sound (a join chime), nor on two probes of the same blip', () => {
    const s = new MeetingSession()
    s.observe(0, [cand(MEET)])
    s.observe(7000, [cand(MEET, { remoteAudio: true })]) // the chime
    s.observe(7200, [cand(MEET, { remoteAudio: true })]) // a quick re-probe of the same chime
    expect(run(s, 8500, 60_000, [cand(MEET)], 1500)).toEqual([])
    // A second sound long after the first is not "sustained" either.
    expect(s.observe(61_000, [cand(MEET, { remoteAudio: true })])).toEqual([])
    expect(s.observe(62_500, [cand(MEET)])).toEqual([])
    // Someone actually talking: two probes 1.5 s apart.
    expect(s.observe(64_000, [cand(MEET, { remoteAudio: true })])).toEqual([{ type: 'start', candidate: cand(MEET, { remoteAudio: true }) }])
  })

  it('keeps timers over short gaps and forgets a pending key after a longer one', () => {
    const s = new MeetingSession()
    s.observe(0, [cand(MEET)])
    s.observe(1000, [])
    // Absent from 1000 to 5000: 4 s, within the 5 s allowance.
    expect(s.observe(5000, [cand(MEET, { remoteAudio: true })])).toEqual([])
    expect(s.observe(6500, [cand(MEET, { remoteAudio: true })])).toEqual([{ type: 'start', candidate: cand(MEET, { remoteAudio: true }) }])

    const t = new MeetingSession()
    t.observe(0, [cand(MEET, { remoteAudio: true })])
    t.observe(1000, [])
    expect(t.observe(6001, [])).toEqual([])
    expect(t.state).toBe('idle')
    // Reappearing starts from scratch: a new firstSeen and no latched remote audio.
    expect(t.observe(7000, [cand(MEET)])).toEqual([])
    expect(t.observe(10_000, [cand(MEET)])).toEqual([])
    expect(t.observe(96_999, [cand(MEET)])).toEqual([])
    expect(t.observe(97_000, [cand(MEET)])).toEqual([{ type: 'start', candidate: cand(MEET) }])
  })

  it('records one meeting at a time and prefers the oldest', () => {
    const s = new MeetingSession()
    s.observe(0, [cand(TEAMS, { remoteAudio: true })])
    s.observe(1000, [cand(TEAMS), cand(MEET, { remoteAudio: true })])
    s.observe(2500, [cand(TEAMS, { remoteAudio: true }), cand(MEET, { remoteAudio: true })])
    // Both qualify at 4000; Teams appeared first.
    const actions = s.observe(4000, [cand(TEAMS), cand(MEET)])
    expect(actions).toEqual([{ type: 'start', candidate: cand(TEAMS) }])
    expect(s.observe(5000, [cand(TEAMS), cand(MEET)])).toEqual([])
    expect(s.current?.key).toBe(TEAMS)
  })

  it('never starts while disabled', () => {
    const s = new MeetingSession({ enabled: false })
    expect(run(s, 0, 200_000, [cand(MEET, { remoteAudio: true })], 5000)).toEqual([])
    expect(s.state).toBe('pending')
  })
})

describe('MeetingSession: recording', () => {
  it('reports title and name hint changes as update', () => {
    const s = startedSession()
    const titled = cand(MEET, { title: 'abc-defg-hij' })
    expect(s.observe(4000, [titled])).toEqual([{ type: 'update', candidate: titled }])
    expect(s.observe(5000, [titled])).toEqual([])
    const hinted = cand(MEET, { title: 'abc-defg-hij', nameHints: ['Blake'] })
    expect(s.observe(6000, [hinted])).toEqual([{ type: 'update', candidate: hinted }])
    expect(s.current).toEqual(hinted)
  })

  it('retargets when the set of other pids changes, not their order', () => {
    const s = startedSession()
    expect(s.observe(4000, [cand(MEET, { otherPids: [100] })])).toEqual([])
    expect(s.observe(5000, [cand(MEET, { otherPids: [140, 100] })])).toEqual([{ type: 'retarget', otherPids: [140, 100] }])
    expect(s.observe(6000, [cand(MEET, { otherPids: [100, 140] })])).toEqual([])
  })

  it('keeps recording through a 15 s end grace and stops after it', () => {
    const s = startedSession()
    expect(s.observe(10_000, [])).toEqual([])
    expect(s.observe(24_999, [])).toEqual([])
    expect(s.state).toBe('recording')
    expect(s.observe(25_000, [])).toEqual([{ type: 'stop', reason: 'ended' }])
    expect(s.state).toBe('idle')
  })

  it('cancels the end grace when the meeting reappears', () => {
    const s = startedSession()
    s.observe(10_000, [])
    expect(s.observe(20_000, [cand(MEET)])).toEqual([])
    expect(s.observe(30_000, [])).toEqual([])
    expect(s.observe(44_999, [])).toEqual([])
    expect(s.observe(45_000, [])).toEqual([{ type: 'stop', reason: 'ended' }])
  })

  it('stops at the maximum duration and does not restart the same call', () => {
    const s = new MeetingSession({ maxDurationMs: 60_000 })
    s.observe(0, [cand(MEET, { remoteAudio: true })])
    s.observe(1500, [cand(MEET, { remoteAudio: true })])
    s.observe(3000, [cand(MEET)])
    expect(s.observe(62_999, [cand(MEET)])).toEqual([])
    expect(s.observe(63_000, [cand(MEET)])).toEqual([{ type: 'stop', reason: 'max-duration' }])
    expect(run(s, 64_000, 300_000, [cand(MEET, { remoteAudio: true })], 5000)).toEqual([])
  })
})

describe('MeetingSession: user stop and suppression', () => {
  it('stops, or discards, and suppresses the call until it has been gone for 15 s', () => {
    const s = startedSession()
    expect(s.stopByUser(10_000, false)).toEqual([{ type: 'stop', reason: 'user' }])
    expect(s.state).toBe('idle')
    // Still in the same call: never restarts, however long it runs.
    expect(run(s, 11_000, 200_000, [cand(MEET, { remoteAudio: true })], 5000)).toEqual([])
    // A short absence does not lift the suppression.
    s.observe(201_000, [])
    expect(run(s, 210_000, 300_000, [cand(MEET, { remoteAudio: true })], 5000)).toEqual([])
    // A 15 s absence does: the next call with this key starts normally.
    s.observe(301_000, [])
    s.observe(316_000, [])
    expect(s.observe(317_000, [cand(MEET, { remoteAudio: true })])).toEqual([])
    expect(s.observe(318_500, [cand(MEET, { remoteAudio: true })])).toEqual([])
    expect(s.observe(320_000, [cand(MEET)])).toEqual([{ type: 'start', candidate: cand(MEET) }])

    const d = startedSession()
    expect(d.stopByUser(5000, true)).toEqual([{ type: 'stop', reason: 'discard' }])
    expect(run(d, 6000, 100_000, [cand(MEET, { remoteAudio: true })], 5000)).toEqual([])
  })

  it('suppresses every pending candidate when stopped before recording, with no action', () => {
    const s = new MeetingSession()
    s.observe(0, [cand(MEET), cand(TEAMS)])
    expect(s.stopByUser(1000, false)).toEqual([])
    expect(s.state).toBe('idle')
    expect(run(s, 2000, 200_000, [cand(MEET, { remoteAudio: true }), cand(TEAMS, { remoteAudio: true })], 5000)).toEqual([])
  })

  it('does nothing when idle', () => {
    expect(new MeetingSession().stopByUser(0, true)).toEqual([])
  })

  it('lets a second call start after the first is stopped', () => {
    const s = new MeetingSession()
    s.observe(0, [cand(MEET, { remoteAudio: true })])
    s.observe(1500, [cand(MEET, { remoteAudio: true })])
    expect(s.observe(3000, [cand(MEET), cand(TEAMS, { remoteAudio: true })])).toEqual([{ type: 'start', candidate: cand(MEET) }])
    s.observe(4500, [cand(MEET), cand(TEAMS, { remoteAudio: true })])
    // Teams has been pending since 3000 with remote audio; its timer kept running.
    expect(s.stopByUser(8000, false)).toEqual([{ type: 'stop', reason: 'user' }])
    expect(s.state).toBe('pending')
    expect(s.observe(9000, [cand(MEET), cand(TEAMS)])).toEqual([{ type: 'start', candidate: cand(TEAMS) }])
  })

  it('starts a waiting call in the same step as the previous one ends', () => {
    const s = startedSession()
    s.observe(4000, [cand(TEAMS)])
    const actions = s.observe(94_000, [cand(TEAMS)])
    expect(actions).toEqual([
      { type: 'stop', reason: 'ended' },
      { type: 'start', candidate: cand(TEAMS) }
    ])
  })
})

describe('MeetingSession: settings', () => {
  it('stops a recording when meetings are disabled', () => {
    const s = startedSession()
    expect(s.setConfig(5000, { enabled: false })).toEqual([{ type: 'stop', reason: 'disabled' }])
    expect(s.state).not.toBe('recording')
    expect(run(s, 6000, 200_000, [cand(MEET, { remoteAudio: true })], 5000)).toEqual([])
  })

  it('changes timings without stopping', () => {
    const s = new MeetingSession()
    expect(s.setConfig(0, { aloneConfirmAfterMs: 10_000 })).toEqual([])
    s.observe(0, [cand(MEET)])
    expect(s.observe(10_000, [cand(MEET)])).toEqual([{ type: 'start', candidate: cand(MEET) }])
  })
})

describe('MeetingSession: continuing without a mic session (muted)', () => {
  const alive = { evidence: true, remoteAudio: true }
  const quiet = { evidence: true, remoteAudio: false }
  const gone = { evidence: false, remoteAudio: false }

  /** Observe no candidates (the app released the mic) with `continuation` every second. */
  function muted(s: MeetingSession, from: number, to: number, continuation: { evidence: boolean; remoteAudio: boolean }) {
    const out: Array<{ at: number; action: unknown }> = []
    for (let t = from; t <= to; t += 1000) for (const action of s.observe(t, [], continuation)) out.push({ at: t, action })
    return out
  }

  it('keeps recording while the others keep talking, however long the mute', () => {
    const s = startedSession()
    expect(muted(s, 4000, 20 * 60_000, alive)).toEqual([])
    expect(s.state).toBe('recording')
  })

  it('ends after 60 s without remote audio plus the usual grace', () => {
    const s = startedSession()
    expect(muted(s, 4000, 30_000, alive)).toEqual([]) // last remote audio at 30 s
    const actions = muted(s, 31_000, 120_000, quiet)
    // Evidence goes stale after 30 + 60 s; the 15 s grace then runs from the first stale observation.
    expect(actions).toEqual([{ at: 106_000, action: { type: 'stop', reason: 'ended' } }])
  })

  it('ends when the call is left, even though the meeting tab title lingers', () => {
    const s = startedSession()
    s.observe(10_000, [cand(MEET, { remoteAudio: true })]) // last remote audio while still in the call
    // Left the call: mic released, the tab title stays, nothing plays.
    const actions = muted(s, 11_000, 200_000, quiet)
    expect(actions).toHaveLength(1)
    expect(actions[0].action).toEqual({ type: 'stop', reason: 'ended' })
    expect(actions[0].at).toBeLessThanOrEqual(10_000 + 60_000 + 15_000 + 1000)
  })

  it('ends 4 s after the meeting window or tab is definitively gone, audio or not', () => {
    const s = startedSession()
    const actions = muted(s, 4000, 60_000, { evidence: false, remoteAudio: true })
    expect(actions).toEqual([{ at: 8000, action: { type: 'stop', reason: 'ended' } }])
  })

  it('keeps the 15 s grace when it cannot tell (no probe result)', () => {
    const s = startedSession()
    const out: Array<{ at: number; action: unknown }> = []
    for (let t = 4000; t <= 30_000; t += 1000) for (const action of s.observe(t, [], () => null)) out.push({ at: t, action })
    expect(out).toEqual([{ at: 19_000, action: { type: 'stop', reason: 'ended' } }])
  })

  it('remembers the last moment the call was evidently live, for trimming', () => {
    const s = startedSession()
    s.observe(10_000, [cand(MEET)])
    for (let t = 12_000; t <= 20_000; t += 2000) s.observe(t, [], alive) // muted, still live
    const out: Array<{ at: number; action: unknown }> = []
    for (let t = 22_000; t <= 40_000; t += 2000) for (const action of s.observe(t, [], gone)) out.push({ at: t, action })
    expect(out).toEqual([{ at: 26_000, action: { type: 'stop', reason: 'ended' } }])
    expect(s.lastLiveAt).toBe(20_000)
  })

  it('trims to the last actual evidence, not to the end of the 60 s continuation window', () => {
    const s = startedSession()
    s.observe(10_000, [cand(MEET, { remoteAudio: true })]) // last moment in the call
    // Left: the tab title lingers and nothing plays, so the continuation window runs out.
    const out = muted(s, 11_000, 200_000, quiet)
    expect(out).toHaveLength(1)
    expect(s.lastLiveAt).toBe(10_000)
  })

  it('counts a muted moment as live only when the far end is actually heard', () => {
    const s = startedSession()
    s.observe(10_000, [cand(MEET)])
    muted(s, 11_000, 20_000, alive) // muted; they talk until 20 s
    muted(s, 21_000, 40_000, quiet) // they fall silent; the call goes on (tab, heard within 60 s)
    expect(s.state).toBe('recording')
    expect(s.lastLiveAt).toBe(20_000)
    muted(s, 41_000, 45_000, alive)
    expect(s.lastLiveAt).toBe(45_000)
  })

  it('continues the same recording when the user unmutes after a long mute', () => {
    const s = startedSession()
    expect(muted(s, 4000, 10 * 60_000, alive)).toEqual([])
    expect(s.observe(10 * 60_000 + 1000, [cand(MEET, { remoteAudio: true })])).toEqual([])
    expect(s.state).toBe('recording')
    expect(run(s, 10 * 60_000 + 2000, 11 * 60_000, [cand(MEET)])).toEqual([])
  })

  it('does not continue a recording that never heard the far end (started alone)', () => {
    const s = new MeetingSession()
    run(s, 0, 89_000, [cand(MEET)])
    expect(s.observe(90_000, [cand(MEET)])).toEqual([{ type: 'start', candidate: cand(MEET) }])
    const actions = muted(s, 91_000, 120_000, quiet)
    expect(actions).toEqual([{ at: 106_000, action: { type: 'stop', reason: 'ended' } }])
  })

  it('never starts or keeps a pending candidate alive from continuation evidence', () => {
    const s = new MeetingSession()
    s.observe(0, [cand(MEET, { remoteAudio: true })])
    expect(muted(s, 1000, 20_000, alive)).toEqual([])
    expect(s.state).toBe('idle')
  })

  it('ignores continuation without it (no mic session means absent)', () => {
    const s = startedSession()
    expect(muted(s, 4000, 30_000, gone)).toEqual([{ at: 8000, action: { type: 'stop', reason: 'ended' } }])
  })
})

describe('MeetingSession: continuing on remote audio alone (Slack: no huddle window)', () => {
  const SLACK = 'slack:500'
  const talking = { evidence: true, remoteAudio: true, audioOnly: true }
  const silent = { evidence: true, remoteAudio: false, audioOnly: true }

  it('ends 15 s after the last sound once the huddle is over, and keeps only up to it (meeting 5)', () => {
    // The real huddle: recording from 16:50:19; Slack released the mic at 17:02:03 (704 s) when
    // the huddle ended and the far end went digitally silent. The old rule kept recording until
    // 17:03:18 (60 s continuation + 15 s grace) and trimmed only to 17:03:02.
    const s = startedSession(SLACK)
    for (let t = 4000; t <= 702_000; t += 2000) s.observe(t, [cand(SLACK, { remoteAudio: t % 6000 === 0 })])
    s.observe(704_000, [cand(SLACK, { remoteAudio: true })]) // "bye", mic session still held
    const out: Array<{ at: number; action: unknown }> = []
    for (let t = 704_400; t <= 800_000; t += 2000) for (const action of s.observe(t, [], silent)) out.push({ at: t, action })
    expect(out).toEqual([{ at: 720_400, action: { type: 'stop', reason: 'ended' } }])
    expect(s.lastLiveAt).toBe(704_000)
  })

  it('keeps a muted huddle alive while the others talk, through pauses shorter than 15 s', () => {
    const s = startedSession(SLACK)
    s.observe(4000, [cand(SLACK)])
    const out: Array<{ at: number; action: unknown }> = []
    // Muted for 20 minutes (Slack released the mic); they talk, with 12 s pauses every minute.
    for (let t = 6000; t <= 20 * 60_000; t += 2000) {
      for (const action of s.observe(t, [], t % 60_000 < 12_000 ? silent : talking)) out.push({ at: t, action })
    }
    expect(out).toEqual([])
    expect(s.state).toBe('recording')
    expect(s.lastLiveAt).toBe(20 * 60_000 - 2000) // the last probe that heard them
  })

  it('ends a muted huddle 15 s after the far end was last heard', () => {
    const s = startedSession(SLACK)
    const out: Array<{ at: number; action: unknown }> = []
    for (let t = 4000; t <= 30_000; t += 2000) for (const action of s.observe(t, [], talking)) out.push({ at: t, action })
    for (let t = 32_000; t <= 90_000; t += 2000) for (const action of s.observe(t, [], silent)) out.push({ at: t, action })
    expect(out).toEqual([{ at: 46_000, action: { type: 'stop', reason: 'ended' } }])
    expect(s.lastLiveAt).toBe(30_000)
  })
})

describe('MeetingSession: a user stop while muted', () => {
  const alive = { evidence: true, remoteAudio: true }
  it('keeps the call suppressed while it continues without a mic session, so unmuting does not restart it', () => {
    const s = startedSession()
    for (let t = 4000; t <= 10_000; t += 1000) s.observe(t, [], alive) // muted, mic released
    expect(s.stopByUser(11_000, false)).toEqual([{ type: 'stop', reason: 'user' }])
    expect(s.watched().map((c) => c.key)).toEqual([MEET])
    // Five muted minutes with the call still on screen and audible (another app's mic keeps the
    // loop observing), then the user unmutes: the same call must not start again.
    for (let t = 12_000; t <= 5 * 60_000; t += 1000) {
      expect(s.observe(t, [], (c) => (c.key === MEET ? alive : null))).toEqual([])
    }
    expect(run(s, 5 * 60_000 + 1000, 6 * 60_000, [cand(MEET, { remoteAudio: true })])).toEqual([])
  })

  it('lifts the suppression once the call is really gone', () => {
    const s = startedSession()
    s.stopByUser(4000, false)
    for (let t = 5000; t <= 30_000; t += 1000) s.observe(t, [], () => ({ evidence: false, remoteAudio: false }))
    expect(s.watched()).toEqual([])
    s.observe(31_000, [cand(MEET, { remoteAudio: true })])
    s.observe(32_500, [cand(MEET, { remoteAudio: true })])
    expect(s.observe(34_000, [cand(MEET)])).toEqual([{ type: 'start', candidate: cand(MEET) }])
  })
})

describe('MeetingSession.startNow (the user chose "Record now")', () => {
  it('starts the pending call at once, without waiting for remote audio or 90 s', () => {
    const s = new MeetingSession()
    s.observe(0, [cand(MEET)])
    expect(s.state).toBe('pending')
    expect(s.startNow(500)).toEqual([{ type: 'start', candidate: cand(MEET) }])
    expect(s.state).toBe('recording')
    // It then behaves like any recording: it ends 15 s after the call goes away.
    expect(run(s, 1000, 15_000, [cand(MEET)])).toEqual([])
    expect(run(s, 16_000, 31_000, [])).toEqual([{ at: 31_000, action: { type: 'stop', reason: 'ended' } }])
  })

  it('does nothing while idle or already recording', () => {
    const idle = new MeetingSession()
    expect(idle.startNow(0)).toEqual([])
    const s = startedSession()
    expect(s.startNow(4000)).toEqual([])
  })

  it('does nothing while disabled', () => {
    const s = new MeetingSession({ enabled: false })
    s.observe(0, [cand(MEET)])
    expect(s.startNow(100)).toEqual([])
  })
})
