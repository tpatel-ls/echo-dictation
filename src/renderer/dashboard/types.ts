export type Page = 'history' | 'dictionary' | 'stats' | 'settings' | 'diagnostics'

/** Optional one-click action on a toast (e.g. Undo for learned corrections). */
export interface ToastAction {
  label: string
  onClick: () => void
}

export type Notify = (message: string, action?: ToastAction) => void
