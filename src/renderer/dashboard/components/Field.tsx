import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5 border-b border-border/50">
      <div className="min-w-0">
        <div className="text-sm text-text">{label}</div>
        {hint && <div className="text-xs text-muted mt-0.5 max-w-md leading-relaxed">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  width = 'w-64'
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  width?: string
}): JSX.Element {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`${width} px-3 py-1.5 bg-bg border border-border rounded-lg text-sm outline-none focus:border-accent/60 placeholder:text-muted`}
    />
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}): JSX.Element {
  return (
    <div className="relative inline-flex">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="appearance-none pl-3 pr-9 py-1.5 bg-bg border border-border rounded-lg text-sm outline-none focus:border-accent/60 cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="w-4 h-4 absolute right-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
    </div>
  )
}
