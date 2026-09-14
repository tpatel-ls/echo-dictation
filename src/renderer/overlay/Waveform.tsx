import { useEffect, useRef, type MutableRefObject } from 'react'

/**
 * Monochrome voice bars on a canvas, driven by the live mic level (never React state). `live` bars
 * rise with your voice, center-weighted with a per-bar shimmer so silence still breathes; `calm`
 * draws a low traveling wave while the final text is decoded. Rendered at devicePixelRatio.
 */
export function Waveform({
  levelRef,
  mode,
  width = 72,
  height = 16,
  bars = 11,
  barWidth = 3,
  gap = 3
}: {
  levelRef: MutableRefObject<number>
  mode: 'live' | 'calm'
  width?: number
  height?: number
  bars?: number
  barWidth?: number
  gap?: number
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const raf = useRef(0)
  const smooth = useRef(0)
  const heights = useRef<number[]>([])
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

    const totalW = bars * barWidth + (bars - 1) * gap
    const startX = (width - totalW) / 2
    const mid = (bars - 1) / 2
    heights.current = Array.from({ length: bars }, () => 0.15)

    const draw = (): void => {
      t.current += 0.05
      const live = modeRef.current === 'live'
      const target = live ? Math.min(1, levelRef.current * 7) : 0
      smooth.current += (target - smooth.current) * 0.28

      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = live ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.5)'

      for (let i = 0; i < bars; i++) {
        const centered = 1 - Math.abs(i - mid) / (mid + 1)
        let goal: number
        if (live) {
          const shimmer = Math.sin(t.current * 5.2 + i * 1.3) * 0.5 + 0.5
          goal = 0.14 + smooth.current * (0.45 + centered * 0.55) * (0.62 + shimmer * 0.38)
        } else {
          goal = 0.16 + (Math.sin(t.current * 2.6 - i * 0.55) * 0.5 + 0.5) * 0.3
        }
        const current = heights.current[i] ?? goal
        const next = current + (goal - current) * (goal > current ? 0.5 : 0.18)
        heights.current[i] = next
        const bh = Math.max(barWidth, Math.min(1, next) * height)
        const x = startX + i * (barWidth + gap)
        roundRect(ctx, x, (height - bh) / 2, barWidth, bh, barWidth / 2)
        ctx.fill()
      }
      raf.current = requestAnimationFrame(draw)
    }
    raf.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf.current)
  }, [levelRef, width, height, bars, barWidth, gap])

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
