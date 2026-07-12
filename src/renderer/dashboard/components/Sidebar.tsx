import { useEffect, useState } from 'react'
import {
  History,
  BookOpen,
  BarChart3,
  Settings as SettingsIcon,
  Stethoscope,
  AudioLines,
  TextQuote,
  type LucideIcon
} from 'lucide-react'
import type { Page } from '../types'
import type { TriggerKey } from '@shared/types'
import { triggerLabel, defaultTriggerKey } from '@shared/trigger'
import { api } from '../lib/api'

const items: { id: Page; label: string; Icon: LucideIcon }[] = [
  { id: 'history', label: 'History', Icon: History },
  { id: 'dictionary', label: 'Dictionary', Icon: BookOpen },
  { id: 'snippets', label: 'Snippets', Icon: TextQuote },
  { id: 'stats', label: 'Stats', Icon: BarChart3 },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
  { id: 'diagnostics', label: 'Diagnostics', Icon: Stethoscope }
]

export function Sidebar({
  page,
  onNavigate
}: {
  page: Page
  onNavigate: (p: Page) => void
}): JSX.Element {
  const [triggerKey, setTriggerKey] = useState<TriggerKey>(() => defaultTriggerKey(api.platform))
  useEffect(() => {
    void api.settings.get().then((s) => setTriggerKey(s.triggerKey))
    const off = api.onSettingsChanged((s) => setTriggerKey(s.triggerKey))
    return () => {
      off()
    }
  }, [])

  return (
    <aside className="w-56 shrink-0 bg-surface border-r border-border flex flex-col">
      <div className="px-5 py-5 flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center">
          <AudioLines className="w-4 h-4 text-white" />
        </span>
        <span className="font-semibold text-[15px] tracking-tight">Echo</span>
      </div>
      <nav className="px-3 flex flex-col gap-1">
        {items.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            aria-current={page === id ? 'page' : undefined}
            className={`relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition active:scale-[0.98] ${
              page === id
                ? 'bg-accent/10 text-accent font-medium'
                : 'text-muted hover:text-text hover:bg-surface2'
            }`}
          >
            {page === id && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-full bg-accent" />
            )}
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </nav>
      <div className="mt-auto p-4 text-xs text-muted leading-relaxed">
        Hold{' '}
        <kbd className="px-1.5 py-0.5 rounded bg-surface2 border border-border text-text text-[11px]">
          {triggerLabel(triggerKey)}
        </kbd>{' '}
        anywhere to dictate.
      </div>
    </aside>
  )
}
