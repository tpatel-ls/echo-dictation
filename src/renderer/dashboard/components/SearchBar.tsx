import type { Ref } from 'react'
import { Search, X } from 'lucide-react'

export function SearchBar({
  value,
  onChange,
  inputRef
}: {
  value: string
  onChange: (v: string) => void
  inputRef?: Ref<HTMLInputElement>
}): JSX.Element {
  return (
    <div className="relative">
      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search transcripts…"
        className="w-full pl-9 pr-9 py-2 bg-surface border border-border rounded-lg text-sm outline-none focus:border-accent/60 placeholder:text-muted"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          title="Clear search"
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted hover:text-text hover:bg-surface2 transition"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}
