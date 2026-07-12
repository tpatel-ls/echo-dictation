// ─────────────────────────────────────────────────────────────────────────────
// Pure PCM → WAV encoder. Mic frames (Float32 at device rate) → 16kHz mono 16-bit
// WAV ArrayBuffer, exactly what Whisper wants. No DOM, no hardware — fully testable.
// ─────────────────────────────────────────────────────────────────────────────

export const TARGET_RATE = 16000

export function encodeWav(frames: Float32Array[], inputRate: number): ArrayBuffer {
  const mono = mergeFrames(frames)
  const resampled = inputRate === TARGET_RATE ? mono : resampleLinear(mono, inputRate, TARGET_RATE)
  return floatToWav(resampled, TARGET_RATE)
}

export function mergeFrames(frames: Float32Array[]): Float32Array {
  let len = 0
  for (const f of frames) len += f.length
  const out = new Float32Array(len)
  let off = 0
  for (const f of frames) {
    out.set(f, off)
    off += f.length
  }
  return out
}

export function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  const ratio = from / to
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)

  if (ratio > 1) {
    // Downsampling needs a low-pass filter before samples are discarded. Without it,
    // energy above the target Nyquist limit folds into the speech band and changes
    // consonants. A compact Hann-windowed sinc keeps capture synchronous and pure.
    const radius = 24
    const cutoff = (to / from) * 0.92
    for (let i = 0; i < outLen; i++) {
      const center = (i + 0.5) * ratio - 0.5
      const left = Math.ceil(center - radius)
      const right = Math.floor(center + radius)
      let weighted = 0
      let weightSum = 0

      for (let sourceIndex = left; sourceIndex <= right; sourceIndex++) {
        if (sourceIndex < 0 || sourceIndex >= input.length) continue
        const distance = sourceIndex - center
        const window = 0.5 * (1 + Math.cos((Math.PI * distance) / radius))
        const x = Math.PI * cutoff * distance
        const sinc = x === 0 ? 1 : Math.sin(x) / x
        const weight = cutoff * sinc * window
        weighted += input[sourceIndex] * weight
        weightSum += weight
      }

      out[i] = weightSum === 0 ? 0 : weighted / weightSum
    }
    return out
  }

  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

export function floatToWav(samples: Float32Array, rate: number): ArrayBuffer {
  const numSamples = samples.length
  const bytesPerSample = 2
  const blockAlign = bytesPerSample // mono
  const dataSize = numSamples * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // audio format = PCM
  view.setUint16(22, 1, true) // channels = mono
  view.setUint32(24, rate, true) // sample rate
  view.setUint32(28, rate * blockAlign, true) // byte rate
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // bits per sample
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    let s = samples[i]
    if (s > 1) s = 1
    else if (s < -1) s = -1
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return buffer
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}
