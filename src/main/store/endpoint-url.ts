export function normalizeEndpointUrl(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return ''

  try {
    const url = new URL(trimmed)
    if (!['http:', 'https:'].includes(url.protocol)) return fallback
    if (url.username || url.password || url.search || url.hash) return fallback
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString().replace(/\/$/, '')
  } catch {
    return fallback
  }
}
