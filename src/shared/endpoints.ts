export interface EndpointValidationOptions {
  required?: boolean
  label?: string
}

export interface EndpointValidationResult {
  normalized: string
  error: string | null
}

export function validateEndpointUrl(
  value: unknown,
  options: EndpointValidationOptions = {}
): EndpointValidationResult {
  const label = options.label ? `${options.label} endpoint` : 'Endpoint'
  if (typeof value !== 'string') return { normalized: '', error: `${label} must be a URL.` }
  const trimmed = value.trim()
  if (!trimmed) {
    return {
      normalized: '',
      error: options.required ? `${label} is required.` : null
    }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { normalized: '', error: 'Enter a full HTTP or HTTPS URL.' }
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return { normalized: '', error: 'Endpoint URLs must use HTTP or HTTPS.' }
  }
  if (url.username || url.password) {
    return { normalized: '', error: 'Remove credentials from the endpoint URL.' }
  }
  if (url.search || url.hash) {
    return { normalized: '', error: 'Endpoint base URLs cannot include a query or fragment.' }
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return { normalized: url.toString().replace(/\/$/, ''), error: null }
}

export function normalizeEndpointUrl(value: unknown, fallback = ''): string {
  const result = validateEndpointUrl(value)
  return result.error ? fallback : result.normalized
}
