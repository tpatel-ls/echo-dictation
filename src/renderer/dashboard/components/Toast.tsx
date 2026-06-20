import type { ToastAction } from '../types'

export function Toast({
  message,
  action
}: {
  message: string | null
  action?: ToastAction | null
}): JSX.Element | null {
  if (!message) return null
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 max-w-[calc(100vw-2.5rem)] bg-[#1a1d24] text-white pl-4 pr-3 py-2.5 rounded-lg text-sm shadow-panel animate-fadeup z-50 flex items-center gap-3">
      <span className="min-w-0 break-words">{message}</span>
      {action && (
        <button
          onClick={action.onClick}
          className="shrink-0 -my-0.5 px-2 py-1 rounded-md bg-white/10 text-accent2 font-medium hover:bg-white/15 transition"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
