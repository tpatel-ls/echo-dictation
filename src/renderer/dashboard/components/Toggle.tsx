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
      className={`group w-10 h-6 rounded-full p-0.5 transition-colors duration-200 shrink-0 cursor-pointer ${
        checked ? 'bg-accent hover:bg-accent2' : 'bg-[#d6d9e0] hover:bg-[#c8ccd5]'
      }`}
    >
      <span
        className={`block w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ease-out group-active:scale-90 ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}
