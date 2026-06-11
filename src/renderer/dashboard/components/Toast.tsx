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
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 bg-[#1a1d24] text-white px-4 py-2 rounded-lg text-sm shadow-panel animate-fadeup z-50 flex items-center gap-3">
      <span>{message}</span>
      {action && (
        <button
          onClick={action.onClick}
          className="text-accent2 font-medium hover:underline shrink-0"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
