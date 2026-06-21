/**
 * A clock that never returns the same value twice and only ever moves forward, so every
 * write gets a unique, strictly-increasing `updated_at`. That uniqueness is what lets the
 * sync push watermark use a strict `>` comparison without ever stranding a row written in
 * the same millisecond as a prior push. `timeSource` is injectable for tests; production
 * uses the wall clock.
 */
export function monotonicClock(timeSource: () => number = () => Date.now()): () => number {
  let last = 0
  return () => {
    last = Math.max(timeSource(), last + 1)
    return last
  }
}
