import { useEffect, useRef, useState } from 'react'
import type { DictationPhase, DictationStateEvent, Settings } from '@shared/types'
import { encodeWav } from '@shared/wav'
import {
  isDeterministicModel,
  PREVIEW_INTERVAL_MS,
  previewFrames,
  previewTail
} from '@shared/live-preview'
import { Check } from 'lucide-react'
import { MicCapture } from './capture'
import { Waveform } from './Waveform'

export function Overlay(): JSX.Element {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [message, setMessage] = useState('')
  const [previewText, setPreviewText] = useState('')
  const levelRef = useRef(0)
  const capture = useRef<MicCapture | null>(null)
  const previewEnabled = useRef(false)
  /** Bumped on every phase change so a preview loop from an earlier dictation stops itself. */
  const previewRun = useRef(0)

  useEffect(() => {
    const cap = new MicCapture()
    cap.onLevel((l) => {
      levelRef.current = l
    })
    capture.current = cap
    window.api.overlayReady()
    const applyPreview = (s: Settings): void => {
      previewEnabled.current = s.livePreview && isDeterministicModel(s.whisperModel)
    }
    window.api.settings
      .get()
      .then((s) => {
        cap.setPreferredDevice(s.audioInputDeviceId)
        applyPreview(s)
        if (s.micMode === 'warm') void cap.setWarm(true)
      })
      .catch(() => {})
    const offState = window.api.onDictationState(onState)
    const offSettings = window.api.onSettingsChanged((s) => {
      cap.setPreferredDevice(s.audioInputDeviceId)
      applyPreview(s)
      void cap.setWarm(s.micMode === 'warm')
    })
    return () => {
      offState()
      offSettings()
      void cap.setWarm(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Ship the audio so far for a decode, one request at a time, until the hotkey is released. */
  async function runPreview(run: number): Promise<void> {
    if (!previewEnabled.current) return
    while (previewRun.current === run) {
      await new Promise((resolve) => setTimeout(resolve, PREVIEW_INTERVAL_MS))
      const cap = capture.current
      if (!cap || previewRun.current !== run) return
      const { frames, sampleRate } = cap.snapshot()
      const recent = previewFrames(frames, sampleRate)
      if (!recent) continue
      const text = await window.api.previewAudio(encodeWav(recent, sampleRate)).catch(() => null)
      if (previewRun.current !== run) return
      if (text) setPreviewText(previewTail(text))
    }
  }

  async function onState(e: DictationStateEvent): Promise<void> {
    const run = ++previewRun.current
    if (e.phase !== 'transcribing') setPreviewText('')
    switch (e.phase) {
      case 'listening':
        setMessage('')
        setPhase('listening')
        try {
          await capture.current?.start()
          void runPreview(run)
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
        levelRef.current = 0
        capture.current?.stop().catch(() => {})
        break
    }
  }

  const showPreview = Boolean(previewText) && (phase === 'listening' || phase === 'transcribing')

  return (
    <div className="ov-root">
      <div className="ov-pill-wrap">
        {showPreview && (
          <div className={`ov-transcript${phase === 'transcribing' ? ' ov-transcript-final' : ''}`}>
            {previewText}
          </div>
        )}
        <div className={`ov-capsule ov-${phase}`}>
          {phase === 'idle' && (
            <span className="ov-idle-bars" aria-label="Echo is ready">
              <i />
              <i />
              <i />
            </span>
          )}

          {phase === 'listening' && (
            <>
              <span className="ov-live-dot" aria-hidden="true" />
              <Waveform levelRef={levelRef} mode="live" width={74} height={14} />
            </>
          )}

          {phase === 'transcribing' && <Waveform levelRef={levelRef} mode="calm" width={54} height={12} />}

          {phase === 'inserted' && (
            <>
              <span className="ov-check">
                <Check size={13} strokeWidth={3} />
              </span>
            </>
          )}

          {phase === 'empty' && <span className="ov-msg-muted">{message}</span>}
          {phase === 'error' && <span className="ov-msg-warn">{message}</span>}
        </div>
      </div>
    </div>
  )
}
