import { Search } from 'lucide-react'

export function SearchBar({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <div className="relative">
      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search transcripts…"
        className="w-full pl-9 pr-3 py-2 bg-surface border border-border rounded-lg text-sm outline-none focus:border-accent/60 placeholder:text-muted"
      />
    </div>
  )
}
