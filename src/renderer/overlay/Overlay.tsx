import { useEffect, useRef, useState } from 'react'
import type { DictationPhase, DictationStateEvent } from '@shared/types'
import { encodeWav } from '@shared/wav'
import { Check, Loader2, Mic2 } from 'lucide-react'
import { MicCapture } from './capture'
import { Waveform } from './Waveform'

export function Overlay(): JSX.Element {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [message, setMessage] = useState('')
  const [startedAt, setStartedAt] = useState(0)
  const [elapsed, setElapsed] = useState('0:00')
  const levelRef = useRef(0)
  const capture = useRef<MicCapture | null>(null)

  useEffect(() => {
    const cap = new MicCapture()
    cap.onLevel((l) => {
      levelRef.current = l
    })
    capture.current = cap
    window.api.overlayReady()
    window.api.settings
      .get()
      .then((s) => {
        cap.setPreferredDevice(s.audioInputDeviceId)
        if (s.micMode === 'warm') void cap.setWarm(true)
      })
      .catch(() => {})
    const offState = window.api.onDictationState(onState)
    const offSettings = window.api.onSettingsChanged((s) => {
      cap.setPreferredDevice(s.audioInputDeviceId)
      void cap.setWarm(s.micMode === 'warm')
    })
    return () => {
      offState()
      offSettings()
      void cap.setWarm(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (phase !== 'listening' || !startedAt) return
    const tick = (): void => setElapsed(formatElapsed(Date.now() - startedAt))
    tick()
    const id = window.setInterval(tick, 250)
    return () => window.clearInterval(id)
  }, [phase, startedAt])

  async function onState(e: DictationStateEvent): Promise<void> {
    switch (e.phase) {
      case 'listening':
        setMessage('')
        setStartedAt(e.startedAt ?? Date.now())
        setPhase('listening')
        try {
          await capture.current?.start()
        } catch (err) {
          const name = (err as Error)?.name
          setPhase('error')
          setMessage(
            name === 'NotAllowedError'
              ? 'Mic blocked — enable microphone access'
              : name === 'NotFoundError'
                ? 'No microphone found'
                : `Mic error: ${name || 'unknown'}`
          )
        }
        break
      case 'transcribing': {
        setPhase('transcribing')
        const cap = capture.current
        if (cap) {
          const { frames, sampleRate } = await cap.stop()
          const total = frames.reduce((n, f) => n + f.length, 0)
          if (total === 0) return
          const durationMs = Math.round((total / sampleRate) * 1000)
          const wav = encodeWav(frames, sampleRate)
          try {
            await window.api.sendAudio(wav, { durationMs, sampleRate })
          } catch {
            /* main reports its own error state */
          }
        }
        break
      }
      case 'inserted':
        setPhase('inserted')
        setMessage(e.message ?? 'Inserted')
        break
      case 'empty':
        setPhase('empty')
        setMessage(e.message ?? 'No speech detected')
        break
      case 'error':
        setPhase('error')
        setMessage(e.message ?? 'Something went wrong')
        break
      case 'idle':
        setPhase('idle')
        setStartedAt(0)
        setElapsed('0:00')
        levelRef.current = 0
        capture.current?.stop().catch(() => {})
        break
    }
  }

  const visible = phase !== 'idle'

  return (
    <div className="ov-root">
      <div className={`ov-pill-wrap ${visible ? 'is-visible' : ''}`}>
        <div className={`ov-capsule ov-${phase}`}>
          {phase === 'listening' && (
            <>
              <span className="ov-live-dot" />
              <Waveform levelRef={levelRef} mode="live" width={204} height={34} />
              <span className="ov-status">
                <Mic2 size={14} />
                Listening
              </span>
              <span className="ov-time">{elapsed}</span>
            </>
          )}

          {phase === 'transcribing' && (
            <>
              <Waveform levelRef={levelRef} mode="calm" width={204} height={34} />
              <span className="ov-status">
                <Loader2 size={14} className="ov-spin" />
                Transcribing
              </span>
            </>
          )}

          {phase === 'inserted' && (
            <>
              <span className="ov-check">
                <Check size={13} strokeWidth={3} />
              </span>
              {message && <span className="ov-text">{message}</span>}
            </>
          )}

          {phase === 'empty' && <span className="ov-msg-muted">{message}</span>}
          {phase === 'error' && <span className="ov-msg-warn">{message}</span>}
        </div>
      </div>
    </div>
  )
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}
