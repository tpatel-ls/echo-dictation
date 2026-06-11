import { useEffect, useState } from 'react'
import type { Stats as StatsType } from '@shared/types'
import { formatDuration } from '@shared/format'
import { Type, FileText, Clock, Flame, CalendarDays } from 'lucide-react'
import { api } from '../lib/api'
import { StatCard } from '../components/StatCard'

export function Stats(): JSX.Element {
  const [s, setS] = useState<StatsType | null>(null)
  useEffect(() => {
    void (async () => setS(await api.history.stats()))()
  }, [])

  return (
    <div className="flex flex-col h-full">
      <header className="px-7 pt-6 pb-4 border-b border-border">
        <h1 className="text-lg font-semibold">Stats</h1>
      </header>
      <div className="flex-1 overflow-y-auto px-7 py-6">
        {s ? (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 max-w-3xl">
            <StatCard label="Words dictated" value={s.totalWords.toLocaleString()} Icon={Type} />
            <StatCard label="Transcripts" value={s.totalTranscripts.toLocaleString()} Icon={FileText} />
            <StatCard
              label="Time saved"
              value={formatDuration(s.estSecondsSaved)}
              sub="vs. typing at 40 wpm"
              Icon={Clock}
            />
            <StatCard
              label="Today"
              value={`${s.todayWords} words`}
              sub={`${s.todayCount} dictation${s.todayCount === 1 ? '' : 's'}`}
              Icon={CalendarDays}
            />
            <StatCard label="Streak" value={`${s.streakDays} day${s.streakDays === 1 ? '' : 's'}`} Icon={Flame} />
          </div>
        ) : (
          <div className="text-muted text-sm">Loading…</div>
        )}
      </div>
    </div>
  )
}
