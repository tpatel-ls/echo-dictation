import { useState } from 'react'
import type { DiagName, DiagResult } from '@shared/types'
import {
  Check,
  X,
  Loader2,
  Mic,
  Keyboard,
  Cloud,
  Sparkles,
  ClipboardPaste,
  type LucideIcon
} from 'lucide-react'
import { api } from '../lib/api'

const CHECKS: { name: DiagName; label: string; Icon: LucideIcon; desc: string }[] = [
  { name: 'whisper', label: 'Whisper endpoint', Icon: Cloud, desc: 'Reach the transcription server on your tailnet.' },
  { name: 'claude', label: 'Claude proxy', Icon: Sparkles, desc: 'Reach the Mac Mini cleanup proxy.' },
  { name: 'hotkey', label: 'Global hotkey', Icon: Keyboard, desc: 'Low-level keyboard hook is running.' },
  { name: 'paste', label: 'Clipboard / paste', Icon: ClipboardPaste, desc: 'Clipboard read/write for inserting text.' },
  { name: 'mic', label: 'Microphone', Icon: Mic, desc: 'Capture audio in this window.' }
]

type State = DiagResult | 'running' | undefined

export function Diagnostics(): JSX.Element {
  const [results, setResults] = useState<Record<string, State>>({})

  const run = async (name: DiagName): Promise<void> => {
    setResults((r) => ({ ...r, [name]: 'running' }))
    const res = name === 'mic' ? await testMic() : await api.diag.run(name)
    setResults((r) => ({ ...r, [name]: res }))
  }
  const runAll = (): void => {
    for (const c of CHECKS) void run(c.name)
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-7 pt-6 pb-4 border-b border-border flex items-center justify-between">
        <h1 className="text-lg font-semibold">Diagnostics</h1>
        <button
          onClick={runAll}
          className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium shadow-sm hover:bg-accent2 active:scale-[0.98] transition"
        >
          Run all
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-7 py-5">
        <div className="flex flex-col gap-2.5 max-w-2xl">
          {CHECKS.map((c) => {
            const r = results[c.name]
            return (
              <div key={c.name} className="bg-surface border border-border rounded-xl p-4 flex items-center gap-4">
                <c.Icon className="w-5 h-5 text-muted shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm flex items-center gap-2">
                    {c.label}
                    {badge(r)}
                  </div>
                  <div className="text-xs text-muted mt-0.5 break-words">
                    {r && r !== 'running' ? r.detail : c.desc}
                  </div>
                </div>
                <button
                  onClick={() => void run(c.name)}
                  disabled={r === 'running'}
                  className="px-3 py-1.5 rounded-lg bg-surface2 text-sm text-text hover:bg-surface2/70 transition shrink-0 disabled:opacity-50 w-16 flex justify-center"
                >
                  {r === 'running' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Test'}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function badge(r: State): JSX.Element | null {
  if (!r || r === 'running') return null
  return r.ok ? (
    <span className="flex items-center gap-1 text-good text-xs">
      <Check className="w-3.5 h-3.5" />
      {r.ms}ms
    </span>
  ) : (
    <span className="flex items-center gap-1 text-bad text-xs">
      <X className="w-3.5 h-3.5" />
      failed
    </span>
  )
}

async function testMic(): Promise<DiagResult> {
  const t0 = Date.now()
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) track.stop()
    return { name: 'mic', ok: true, detail: 'Microphone accessible.', ms: Date.now() - t0 }
  } catch (e) {
    return { name: 'mic', ok: false, detail: (e as Error).message, ms: Date.now() - t0 }
  }
}
