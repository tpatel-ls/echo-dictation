// ─────────────────────────────────────────────────────────────────────────────
// MeetingSession: when to start and stop recording, given successive detector snapshots. Pure and
// clock-free (the caller passes `now`), one recording at a time. A lobby never starts a recording
// until either the far end has been heard or 90 s have passed; a call the user stopped stays
// stopped until it goes away. A recording outlives its app's mic session (a mute that releases the
// mic) while the meeting's window or tab remains and the far end was heard recently. Spec:
// "Session state machine".
// ─────────────────────────────────────────────────────────────────────────────

import type { MeetingCandidate, MeetingSessionAction, MeetingStopReason } from './meeting-types'

export interface MeetingSessionConfig {
  enabled: boolean
  /** Presence needed before starting once remote audio has been heard. */
  confirmAfterMs: number
  /** Presence needed before starting without ever hearing remote audio (you joined first). */
  aloneConfirmAfterMs: number
  /** Continuous absence that ends a recording (and lifts a suppression). */
  endAfterMs: number
  maxDurationMs: number
  /** Absence after which a pending candidate's timers reset. */
  forgetPendingAfterMs: number
  /**
   * While recording without a mic session, the meeting's evidence keeps it alive only if the far
   * end was heard this recently (a lingering tab after leaving a call must not keep recording).
   */
  continueWithoutMicMs: number
  /**
   * Absence that ends a recording when the meeting is definitively gone: no mic session and the
   * probe found no meeting tab or window (the call was left or closed).
   */
  endWhenGoneMs: number
  /**
   * The far end counts as heard only after remote audio in two probes at least this far apart and
   * at most `remoteConfirmMaxGapMs` apart: sustained sound, not a join chime or a ringtone blip.
   */
  remoteConfirmMinGapMs: number
  remoteConfirmMaxGapMs: number
}

/**
 * The recorded meeting's state when its app holds no mic session (see `continuationEvidence` in
 * meeting-detect): its window or tab still exists, and whether the far end is audible right now.
 */
export interface MeetingContinuation {
  evidence: boolean
  remoteAudio: boolean
  joined?: boolean
  /**
   * The evidence is assumed, not seen: the app shows no meeting window or tab to check (Slack
   * huddles), or only a browser title remains after capture stops. Only the far end being heard keeps such a call going, and it ends
   * `endAfterMs` after the last sound rather than after the 60 s continuation window.
   */
  audioOnly?: boolean
}

export const DEFAULT_SESSION_CONFIG: MeetingSessionConfig = {
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
}

export type MeetingSessionState = 'idle' | 'pending' | 'recording'

interface Pending {
  candidate: MeetingCandidate
  firstSeen: number
  /** Latched: remote audio was heard at least once since `firstSeen`. */
  heardRemote: boolean
  /** When remote audio was last heard, or null. */
  lastRemoteAt: number | null
  /** First observation at which the key was missing, or null while present. */
  absentSince: number | null
}

interface Recording {
  candidate: MeetingCandidate
  startedAt: number
  absentSince: number | null
  lastRemoteAt: number | null
  /**
   * The last observation with actual evidence of the call: its app held a mic session, or (muted)
   * the far end was heard. Never the mere continuation window.
   */
  lastLiveAt: number
}

interface Suppressed {
  candidate: MeetingCandidate
  /** First observation at which the key was gone (no mic session, no fresh evidence), or null. */
  absentSince: number | null
  lastRemoteAt: number | null
  autoEnded?: boolean
  sawLeft?: boolean
}

function differentCall(a: MeetingCandidate, b: MeetingCandidate): boolean {
  return Boolean(a.callId && b.callId && a.callId !== b.callId)
}

/**
 * Continuation for one candidate that holds no mic session, or null when unknown. An object applies
 * to the recording only (kept for callers that track just that one).
 */
export type ContinuationSource = MeetingContinuation | ((candidate: MeetingCandidate) => MeetingContinuation | null) | null

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function sameSet(a: number[], b: number[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every((v) => sb.has(v))
}

export class MeetingSession {
  private config: MeetingSessionConfig
  private pending = new Map<string, Pending>()
  private recording: Recording | null = null
  private lastLive: number | null = null
  /** Calls the user stopped (or that hit the time cap), kept until they are really gone. */
  private suppressed = new Map<string, Suppressed>()

  constructor(config: Partial<MeetingSessionConfig> = {}) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config }
  }

  /**
   * The last moment the current (or most recently stopped) recording was evidently live: the
   * recording is trimmed to it when the call ends, so nothing after the meeting is kept.
   */
  get lastLiveAt(): number | null {
    return this.lastLive
  }

  get state(): MeetingSessionState {
    if (this.recording) return 'recording'
    return this.pending.size > 0 ? 'pending' : 'idle'
  }

  /** The recording candidate (latest version), else the oldest pending one, else null. */
  get current(): MeetingCandidate | null {
    if (this.recording) return this.recording.candidate
    return this.oldestPending(() => true)?.candidate ?? null
  }

  /**
   * The recorded call and the calls the user stopped: the caller keeps probing their apps (even
   * without a mic session) and reports their continuation evidence to `observe`.
   */
  watched(): MeetingCandidate[] {
    const out = [...this.suppressed.values()].map((s) => s.candidate)
    return this.recording ? [this.recording.candidate, ...out] : out
  }

  /**
   * One detector snapshot. `continuation` describes watched calls whose app holds no mic session
   * (see `watched`); it never affects pending candidates.
   */
  observe(now: number, candidates: MeetingCandidate[], continuation: ContinuationSource = null): MeetingSessionAction[] {
    const present = new Map(candidates.map((c) => [c.key, c]))
    const actions: MeetingSessionAction[] = []
    const continuationOf = (c: MeetingCandidate, recording: boolean): MeetingContinuation | null =>
      typeof continuation === 'function' ? continuation(c) : recording ? continuation : null

    // A stopped call stays suppressed while it is present, or continues without a mic session (a
    // mute), so unmuting never restarts a call the user stopped.
    for (const [key, s] of this.suppressed) {
      const seen = present.get(key)
      if (seen && (differentCall(s.candidate, seen) || (s.autoEnded && s.sawLeft && seen.joined))) {
        this.suppressed.delete(key)
        this.pending.delete(key)
        continue
      }
      const continuation = continuationOf(s.candidate, false)
      if (continuation?.joined === false) s.sawLeft = true
      if (seen) {
        s.candidate = seen
        s.absentSince = null
        if (seen.remoteAudio) s.lastRemoteAt = now
        continue
      }
      if (this.continues(now, s, continuation)) {
        s.absentSince = null
        continue
      }
      s.absentSince ??= now
      if (now - s.absentSince >= this.config.endAfterMs) this.suppressed.delete(key)
    }

    // Recording first, so a key that just stopped is suppressed or gone before pending is updated.
    if (this.recording) {
      const rec = this.recording
      actions.push(...this.observeRecording(now, present.get(rec.candidate.key), continuationOf(rec.candidate, true)))
    }

    for (const [key, p] of this.pending) {
      if (present.has(key)) continue
      if (p.absentSince === null) p.absentSince = now
      if (now - p.absentSince > this.config.forgetPendingAfterMs) this.pending.delete(key)
    }
    for (const original of candidates) {
      const suppressed = this.suppressed.get(original.key)
      if (suppressed && differentCall(suppressed.candidate, original)) this.suppressed.delete(original.key)
      const blocked = this.suppressed.get(original.key)
      if ((blocked && !blocked.autoEnded) || this.recording?.candidate.key === original.key) continue
      // A real rejoin whose page is inaccessible remains manually recoverable. Stale signals
      // can never auto-start a second recording until the old call has genuinely gone away.
      const c = blocked ? { ...original, requiresConfirmation: true } : original
      const previous = this.pending.get(c.key)
      if (previous && differentCall(previous.candidate, c)) this.pending.delete(c.key)
      const p = this.pending.get(c.key)
      if (p) {
        p.candidate = c
        p.absentSince = null
        if (p.lastRemoteAt !== null && now - p.lastRemoteAt > this.config.remoteConfirmMaxGapMs) {
          p.heardRemote = false
          p.lastRemoteAt = null
        }
        if (c.remoteAudio) {
          const gap = p.lastRemoteAt === null ? null : now - p.lastRemoteAt
          if (gap !== null && gap >= this.config.remoteConfirmMinGapMs && gap <= this.config.remoteConfirmMaxGapMs) {
            p.heardRemote = true
          }
          // A quick re-probe of the same sound does not move the first hit forward.
          if (gap === null || gap >= this.config.remoteConfirmMinGapMs) p.lastRemoteAt = now
        }
      } else {
        this.pending.set(c.key, {
          candidate: c,
          firstSeen: now,
          heardRemote: false,
          lastRemoteAt: c.remoteAudio ? now : null,
          absentSince: null
        })
      }
    }

    if (!this.recording && this.config.enabled) {
      const ready = this.oldestPending(
        (p) =>
          p.absentSince === null &&
          !p.candidate.requiresConfirmation &&
          (((p.heardRemote || p.candidate.joined) && now - p.firstSeen >= this.config.confirmAfterMs) ||
            (!p.candidate.requiresRemoteAudio && p.candidate.app !== 'slack' && now - p.firstSeen >= this.config.aloneConfirmAfterMs))
      )
      if (ready) {
        this.pending.delete(ready.candidate.key)
        this.recording = { candidate: ready.candidate, startedAt: now, absentSince: null, lastRemoteAt: ready.lastRemoteAt, lastLiveAt: now }
        this.lastLive = now
        actions.push({ type: 'start', candidate: ready.candidate })
      }
    }
    return actions
  }

  /** The user chose to record the waiting call now: start it without the remote-audio / 90 s gate. */
  startNow(now: number): MeetingSessionAction[] {
    if (this.recording || !this.config.enabled) return []
    const p = this.oldestPending((q) => q.absentSince === null)
    if (!p) return []
    this.pending.delete(p.candidate.key)
    this.suppressed.delete(p.candidate.key)
    this.recording = { candidate: p.candidate, startedAt: now, absentSince: null, lastRemoteAt: p.lastRemoteAt, lastLiveAt: now }
    this.lastLive = now
    return [{ type: 'start', candidate: p.candidate }]
  }

  stopByUser(now: number, discard: boolean): MeetingSessionAction[] {
    if (this.recording) return [this.stop(discard ? 'discard' : 'user', true)]
    for (const [key, p] of this.pending) {
      this.suppressed.set(key, { candidate: p.candidate, absentSince: p.absentSince, lastRemoteAt: p.lastRemoteAt })
    }
    this.pending.clear()
    return []
  }

  /** An interrupted helper is recoverable; it must not suppress the still-live call. */
  interrupt(): MeetingSessionAction[] {
    return this.recording ? [this.stop('ended', false)] : []
  }

  setConfig(now: number, config: Partial<MeetingSessionConfig>): MeetingSessionAction[] {
    this.config = { ...this.config, ...config }
    if (!this.config.enabled && this.recording) return [this.stop('disabled', false)]
    return []
  }

  private observeRecording(
    now: number,
    seen: MeetingCandidate | undefined,
    continuation: MeetingContinuation | null
  ): MeetingSessionAction[] {
    const rec = this.recording!
    if (seen && differentCall(rec.candidate, seen)) return [this.stop('ended', true)]
    if (seen?.remoteAudio) rec.lastRemoteAt = now
    if (now - rec.startedAt >= this.config.maxDurationMs) {
      if (seen) rec.absentSince = null
      return [this.stop('max-duration', true)]
    }
    if (!seen && continuation?.evidence === true && (continuation.remoteAudio || continuation.joined === true)) {
      // Muted with the mic released, and the far end is heard right now: actual evidence.
      rec.lastLiveAt = now
      this.lastLive = now
    }
    if (!seen && continuation?.evidence === true && continuation.audioOnly) {
      // Only its sound shows the call goes on: it ends once the far end has been quiet for the grace.
      if (continuation.remoteAudio) rec.lastRemoteAt = now
      rec.absentSince = null
      return now - rec.lastLiveAt >= this.config.endAfterMs ? [this.stop('ended', true)] : []
    }
    if (!seen && this.continues(now, rec, continuation)) {
      // Muted with the mic released: the meeting is still on screen and the far end was heard recently.
      rec.absentSince = null
      return []
    }
    if (!seen) {
      rec.absentSince ??= now
      // Left or closed (the probe found no meeting tab or window): end quickly. Unknown: the usual grace.
      const grace = continuation && !continuation.evidence ? this.config.endWhenGoneMs : this.config.endAfterMs
      return now - rec.absentSince >= grace ? [this.stop('ended', true)] : []
    }
    rec.absentSince = null
    rec.lastLiveAt = now
    this.lastLive = now
    const prev = rec.candidate
    rec.candidate = seen
    const actions: MeetingSessionAction[] = []
    if (!sameSet(prev.otherPids, seen.otherPids)) actions.push({ type: 'retarget', otherPids: seen.otherPids })
    if (prev.title !== seen.title || !sameList(prev.nameHints, seen.nameHints) ||
        JSON.stringify(prev.participants) !== JSON.stringify(seen.participants) || prev.micMuted !== seen.micMuted) {
      actions.push({ type: 'update', candidate: seen })
    }
    return actions
  }

  /**
   * Without a mic session, a call goes on while its window or tab remains and the far end was
   * heard within `continueWithoutMicMs` (updates `lastRemoteAt`).
   */
  private continues(
    now: number,
    call: { lastRemoteAt: number | null },
    continuation: MeetingContinuation | null
  ): boolean {
    if (continuation?.joined !== undefined) return continuation.joined
    if (continuation?.remoteAudio) call.lastRemoteAt = now
    return (
      continuation?.evidence === true &&
      call.lastRemoteAt !== null &&
      now - call.lastRemoteAt <= this.config.continueWithoutMicMs
    )
  }

  private stop(reason: MeetingStopReason, suppress: boolean): MeetingSessionAction {
    const rec = this.recording!
    if (suppress) {
      this.suppressed.set(rec.candidate.key, {
        candidate: rec.candidate,
        // Require a fresh absence after stopping, not the grace period that triggered stop.
        absentSince: null,
        lastRemoteAt: rec.lastRemoteAt,
        autoEnded: reason === 'ended'
      })
    }
    this.recording = null
    return { type: 'stop', reason }
  }

  private oldestPending(ok: (p: Pending) => boolean): Pending | null {
    let best: Pending | null = null
    for (const p of this.pending.values()) {
      if (!ok(p)) continue
      if (
        !best ||
        p.firstSeen < best.firstSeen ||
        (p.firstSeen === best.firstSeen && p.candidate.key < best.candidate.key)
      ) {
        best = p
      }
    }
    return best
  }
}
