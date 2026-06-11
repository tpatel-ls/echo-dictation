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
    <div className="bg-surface border border-border rounded-xl p-4 flex flex-col gap-1">
      <div className="flex items-center gap-2 text-muted text-xs">
        {Icon && <Icon className="w-3.5 h-3.5" />}
        {label}
      </div>
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  )
}
