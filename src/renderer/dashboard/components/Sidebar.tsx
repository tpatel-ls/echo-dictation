import {
  History,
  BookOpen,
  BarChart3,
  Settings as SettingsIcon,
  Stethoscope,
  AudioLines,
  type LucideIcon
} from 'lucide-react'
import type { Page } from '../types'

const items: { id: Page; label: string; Icon: LucideIcon }[] = [
  { id: 'history', label: 'History', Icon: History },
  { id: 'dictionary', label: 'Dictionary', Icon: BookOpen },
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
            className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
              page === id
                ? 'bg-accent/10 text-accent font-medium'
                : 'text-muted hover:text-text hover:bg-surface2'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </nav>
      <div className="mt-auto p-4 text-xs text-muted leading-relaxed">
        Hold{' '}
        <kbd className="px-1.5 py-0.5 rounded bg-surface2 border border-border text-text text-[11px]">
          Right Ctrl
        </kbd>{' '}
        anywhere to dictate.
      </div>
    </aside>
  )
}
