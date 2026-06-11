export function Toggle({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`w-10 h-6 rounded-full p-0.5 transition shrink-0 ${
        checked ? 'bg-accent' : 'bg-[#d6d9e0]'
      }`}
    >
      <span
        className={`block w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}
