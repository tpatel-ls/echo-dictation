// Live transcript preview: while the hotkey is held, the overlay periodically ships the audio captured
// so far for a best-effort decode and shows the newest words in the bar. The final decode at release
// remains the only text that is ever inserted.

export interface PreviewWindow {
  /** Skip the decode until at least this much audio exists. */
  minMs: number
  /** Long dictations only send the most recent audio so each preview request stays small and fast. */
  maxMs: number
}

export const PREVIEW_WINDOW: PreviewWindow = { minMs: 600, maxMs: 20_000 }
/** Pause between one preview response and the next request. */
export const PREVIEW_INTERVAL_MS = 350
/** About two lines of the transcript bubble above the recording pill. */
export const PREVIEW_MAX_CHARS = 110

/** Non-autoregressive recognizers (NVIDIA Parakeet TDT/CTC) decode greedily and ignore temperature, so
 *  re-decoding the same audio returns the same text and they are fast enough for live previews. */
export function isDeterministicModel(model: string): boolean {
  return /parakeet/i.test(model)
}

/** The frames worth decoding for a preview, or null while the utterance is still too short. */
export function previewFrames(
  frames: Float32Array[],
  sampleRate: number,
  window: PreviewWindow = PREVIEW_WINDOW
): Float32Array[] | null {
  const total = frames.reduce((n, frame) => n + frame.length, 0)
  if (total < (sampleRate * window.minMs) / 1000) return null
  const maxSamples = (sampleRate * window.maxMs) / 1000
  if (total <= maxSamples) return frames.slice()
  let start = frames.length
  let kept = 0
  while (start > 0 && kept + (frames[start - 1]?.length ?? 0) <= maxSamples) {
    start--
    kept += frames[start]?.length ?? 0
  }
  return frames.slice(start)
}

/** The newest words of a preview, trimmed on a word boundary so the bar never shows half a word. */
export function previewTail(text: string, maxChars: number = PREVIEW_MAX_CHARS): string {
  const t = text.trim().replace(/\s+/g, ' ')
  if (t.length <= maxChars) return t
  const start = t.length - maxChars
  const cut = t.slice(start)
  if (t[start - 1] === ' ') return `…${cut}`
  const space = cut.indexOf(' ')
  return `…${space >= 0 ? cut.slice(space + 1) : cut}`
}
