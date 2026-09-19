import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DictationPhase, DictationStateEvent, Settings } from '@shared/types'
import { encodeWav } from '@shared/wav'
import { PREVIEW_INTERVAL_MS, PreviewAudio, supportsLivePreview } from '@shared/live-preview'
import { Check } from 'lucide-react'
import { MicCapture } from './capture'
import { Waveform } from './Waveform'

/** Enough words to fill the two visible lines; older words scroll out above. */
const CARD_MAX_WORDS = 48

export function Overlay(): JSX.Element {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [message, setMessage] = useState('')
  const [previewText, setPreviewText] = useState('')
  const levelRef = useRef(0)
  const capture = useRef<MicCapture | null>(null)
  const previewEnabled = useRef(false)
  /** Bumped on every phase change so a preview loop from an earlier dictation stops itself. */
  const previewRun = useRef(0)
  const previewAudio = useRef(new PreviewAudio())

  useEffect(() => {
    const cap = new MicCapture()
    cap.onLevel((l) => {
      levelRef.current = l
    })
    cap.onFrame((frame, sampleRate) => {
      if (previewEnabled.current) previewAudio.current.push(frame, sampleRate)
    })
    cap.onEvent((event) => window.api.logMic(event))
    capture.current = cap
    window.api.overlayReady()
    const applyPreview = (s: Settings): void => {
      previewEnabled.current = s.livePreview && supportsLivePreview(s.previewModel)
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
      cap.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Ship the audio so far for a decode, one request at a time, until the hotkey is released. */
  async function runPreview(run: number): Promise<void> {
    if (!previewEnabled.current) return
    while (previewRun.current === run) {
      await new Promise((resolve) => setTimeout(resolve, PREVIEW_INTERVAL_MS))
      if (previewRun.current !== run) return
      const wav = previewAudio.current.wav()
      if (!wav) continue
      const text = await window.api.previewAudio(wav).catch(() => null)
      if (previewRun.current !== run) return
      if (text) setPreviewText(text)
    }
  }

  async function onState(e: DictationStateEvent): Promise<void> {
    const run = ++previewRun.current
    if (e.phase !== 'transcribing') setPreviewText('')
    switch (e.phase) {
      case 'listening':
        setMessage('')
        setPhase('listening')
        previewAudio.current.reset()
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
          // Even an empty take goes to main, which reports the dead mic instead of waiting for its watchdog.
          const total = frames.reduce((n, f) => n + f.length, 0)
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

  const showCard = Boolean(previewText) && (phase === 'listening' || phase === 'transcribing')

  return (
    <div className="ov-root">
      <div className="ov-stack">
        {showCard && <TranscriptCard text={previewText} finalizing={phase === 'transcribing'} />}
        <div className={`ov-pill ov-${phase}`} role="status" aria-live="polite">
          {phase === 'listening' && <Waveform levelRef={levelRef} mode="live" width={78} height={18} />}
          {phase === 'transcribing' && (
            <>
              <Waveform levelRef={levelRef} mode="calm" width={78} height={18} />
              <span className="ov-sheen" aria-hidden="true" />
            </>
          )}
          {phase === 'inserted' && (
            <span className="ov-check" aria-label="Inserted">
              <Check size={12} strokeWidth={3.25} />
            </span>
          )}
          {phase === 'empty' && <span className="ov-msg ov-msg-muted">{message}</span>}
          {phase === 'error' && <span className="ov-msg ov-msg-warn">{message}</span>}
        </div>
      </div>
    </div>
  )
}

/**
 * The words heard so far, bottom-anchored to two lines. Each word is keyed by its position in the
 * whole utterance, so only newly heard words mount and fade in; revisions update in place.
 */
function TranscriptCard({ text, finalizing }: { text: string; finalizing: boolean }): JSX.Element {
  const words = text.split(/\s+/).filter(Boolean)
  const start = Math.max(0, words.length - CARD_MAX_WORDS)
  const body = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const el = body.current
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1)
  }, [text])

  return (
    <div className={`ov-card${finalizing ? ' ov-card-finalizing' : ''}`}>
      <div ref={body} className={`ov-card-text${overflowing ? ' ov-card-overflow' : ''}`}>
        {words.slice(start).map((word, index) => (
          <span key={start + index} className="ov-word">
            {word}
          </span>
        ))}
      </div>
    </div>
  )
}
