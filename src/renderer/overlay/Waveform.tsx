import { useEffect, useRef, type MutableRefObject } from 'react'

const N = 23
const BAR_W = 3
const GAP = 2.5

/**
 * Symmetric, center-weighted audio equalizer on a canvas, driven by the live mic
 * level (never React state). `live` bars rise with your voice + a per-bar phase
 * shimmer for organic life; `calm` draws a low traveling wave for the processing
 * state. Rendered at devicePixelRatio for crisp edges.
 */
export function Waveform({
  levelRef,
  mode,
  width = 180,
  height = 30
}: {
  levelRef: MutableRefObject<number>
  mode: 'live' | 'calm'
  width?: number
  height?: number
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const raf = useRef(0)
  const smooth = useRef(0)
  const t = useRef(0)
  const modeRef = useRef(mode)
  modeRef.current = mode

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)

    const scale = Math.min(1, width / (N * BAR_W + (N - 1) * GAP))
    const barWidth = Math.max(1.25, BAR_W * scale)
    const gap = Math.max(0.75, GAP * scale)
    const totalW = N * barWidth + (N - 1) * gap
    const startX = (width - totalW) / 2
    const mid = (N - 1) / 2

    const draw = (): void => {
      t.current += 0.05
      const live = modeRef.current === 'live'
      const target = live ? Math.min(1, levelRef.current * 6) : 0
      smooth.current += (target - smooth.current) * 0.3

      ctx.clearRect(0, 0, width, height)
      const voiceActive = live && smooth.current > 0.055
      const grad = ctx.createLinearGradient(0, 0, 0, height)
      if (voiceActive) {
        grad.addColorStop(0, 'rgba(115,190,255,1)')
        grad.addColorStop(1, 'rgba(55,137,255,0.88)')
      } else if (live) {
        grad.addColorStop(0, 'rgba(255,255,255,0.92)')
        grad.addColorStop(1, 'rgba(255,255,255,0.62)')
      } else {
        grad.addColorStop(0, 'rgba(255,255,255,0.56)')
        grad.addColorStop(1, 'rgba(255,255,255,0.34)')
      }
      ctx.fillStyle = grad
      ctx.shadowColor = voiceActive ? 'rgba(74,156,255,0.48)' : 'rgba(255,255,255,0.22)'
      ctx.shadowBlur = live ? 4 : 0

      for (let i = 0; i < N; i++) {
        const cw = 1 - Math.abs(i - mid) / mid
        let amp: number
        if (live) {
          const shimmer = (Math.sin(t.current * 6 + i * 0.7) * 0.5 + 0.5) * 0.35 + 0.65
          const base = 0.12 + smooth.current * 0.95
          amp = base * Math.pow(0.32 + cw * 0.68, 1.3) * shimmer
        } else {
          amp = 0.14 + (Math.sin(t.current * 2.4 - i * 0.45) * 0.5 + 0.5) * 0.22
        }
        const bh = Math.max(2.5, Math.min(1, amp) * height)
        const x = startX + i * (barWidth + gap)
        const y = (height - bh) / 2
        roundRect(ctx, x, y, barWidth, bh, barWidth / 2)
        ctx.fill()
      }
      raf.current = requestAnimationFrame(draw)
    }
    raf.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf.current)
  }, [levelRef, width, height])

  return <canvas ref={canvasRef} style={{ width, height, display: 'block' }} />
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}
