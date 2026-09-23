import { useCallback, useEffect, useRef, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { Toast } from './components/Toast'
import { History } from './pages/History'
import { Meetings, type MeetingFocus } from './pages/Meetings'
import { api } from './lib/api'
import { Dictionary } from './pages/Dictionary'
import { Snippets } from './pages/Snippets'
import { Stats } from './pages/Stats'
import { Settings } from './pages/Settings'
import { Diagnostics } from './pages/Diagnostics'
import type { Page, ToastAction } from './types'

export function App(): JSX.Element {
  const [page, setPage] = useState<Page>('history')
  const [toast, setToast] = useState<{ message: string; action?: ToastAction } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const notify = useCallback((message: string, action?: ToastAction): void => {
    const withDismiss = action
      ? {
          message,
          action: {
            ...action,
            onClick: () => {
              action.onClick()
              setToast(null)
            }
          }
        }
      : { message }
    setToast(withDismiss)
    if (timer.current) clearTimeout(timer.current)
    // Toasts with an action (Undo) stay long enough to actually click them.
    timer.current = setTimeout(() => setToast(null), action ? 6000 : 2200)
  }, [])

  // Main (tray, notification, pill) asks for the Meetings page and optionally one meeting.
  const [meetingFocus, setMeetingFocus] = useState<MeetingFocus | null>(null)
  useEffect(() => {
    return api.meetings.onEvent((e) => {
      if (e.type !== 'navigate') return
      setPage('meetings')
      setMeetingFocus((cur) => ({ meetingId: e.meetingId, nonce: (cur?.nonce ?? 0) + 1 }))
    })
  }, [])

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar page={page} onNavigate={setPage} />
      <main className="flex-1 min-w-0 bg-bg">
        {page === 'history' && <History notify={notify} />}
        {page === 'meetings' && <Meetings notify={notify} focus={meetingFocus} />}
        {page === 'dictionary' && <Dictionary notify={notify} />}
        {page === 'snippets' && <Snippets notify={notify} />}
        {page === 'stats' && <Stats />}
        {page === 'settings' && <Settings notify={notify} />}
        {page === 'diagnostics' && <Diagnostics notify={notify} />}
      </main>
      <Toast message={toast?.message ?? null} action={toast?.action} />
    </div>
  )
}
