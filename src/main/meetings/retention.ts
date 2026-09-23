import { rmSync } from 'node:fs'
import { relative, isAbsolute } from 'node:path'
import type { MeetingsStore } from '../store/meetings'

// Meeting audio is kept for `meetingRetainAudioDays` after a meeting ends, then deleted on launch
// and once a day. Only the PCM directory goes: the .md in the output folder and the
// `<uuid>.speakers.json` next to the audio directory (needed to remember a voice later) stay.

const DAY_MS = 24 * 60 * 60 * 1000

export interface RetentionDeps {
  meetings: MeetingsStore
  /** userData/meetings; nothing outside it is ever deleted. */
  meetingsDir: string
  retainDays: () => number
  now?: () => number
  removeDir?: (path: string) => void
  log?: (message: string) => void
}

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Delete expired meeting audio; returns how many meetings lost their audio. */
export function pruneMeetingAudio(deps: RetentionDeps): number {
  const now = (deps.now ?? Date.now)()
  const days = Math.max(0, deps.retainDays())
  const remove = deps.removeDir ?? ((path: string) => rmSync(path, { recursive: true, force: true }))
  let pruned = 0
  for (const m of deps.meetings.audioExpired(now - days * DAY_MS)) {
    if (!m.audio_dir) continue
    if (!inside(deps.meetingsDir, m.audio_dir)) {
      deps.log?.(`retention: meeting ${m.id} audio is outside the meetings folder; left alone`)
      continue
    }
    try {
      remove(m.audio_dir)
    } catch (e) {
      deps.log?.(`retention: could not delete meeting ${m.id} audio (${(e as Error).name})`)
      continue
    }
    deps.meetings.update(m.id, { audio_dir: null })
    pruned++
  }
  if (pruned) deps.log?.(`retention: deleted the audio of ${pruned} meeting(s)`)
  return pruned
}

/** Prune now and then every 24 h; returns a stop function. */
export function scheduleRetention(deps: RetentionDeps, intervalMs = DAY_MS): () => void {
  const run = (): void => {
    try {
      pruneMeetingAudio(deps)
    } catch (e) {
      deps.log?.(`retention: failed (${(e as Error).name})`)
    }
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
