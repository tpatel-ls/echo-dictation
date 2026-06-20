import type { LucideIcon } from 'lucide-react'

export function StatCard({
  label,
  value,
  sub,
  Icon
}: {
  label: string
  value: string
  sub?: string
  Icon?: LucideIcon
}): JSX.Element {
  return (
    <div className="bg-surface border border-border rounded-xl p-4 flex flex-col gap-2 transition hover:border-[#d4d7de] hover:shadow-card">
      <div className="flex items-center gap-2 text-muted text-xs">
        {Icon && (
          <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-accent/10 text-accent">
            <Icon className="w-3.5 h-3.5" />
          </span>
        )}
        {label}
      </div>
      <div className="text-2xl font-semibold tracking-tight text-text">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  )
}
