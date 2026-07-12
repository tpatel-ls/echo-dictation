import { describe, expect, it } from 'vitest'
import { normalizeEndpointUrl } from '../src/main/store/endpoint-url'
import { normalizeSettings } from '../src/main/store/settings-migration'

describe('normalizeEndpointUrl', () => {
  it('trims and canonicalizes HTTP and HTTPS base URLs', () => {
    expect(normalizeEndpointUrl('  HTTPS://Example.COM:443/v1///  ')).toBe('https://example.com/v1')
    expect(normalizeEndpointUrl('http://localhost:8787/')).toBe('http://localhost:8787')
  })

  it('allows an empty URL to disable an optional endpoint', () => {
    expect(normalizeEndpointUrl('   ')).toBe('')
  })

  it('rejects relative URLs, unsupported schemes, and embedded credentials', () => {
    expect(normalizeEndpointUrl('/v1', 'https://safe.example')).toBe('https://safe.example')
    expect(normalizeEndpointUrl('file:///tmp/proxy', 'https://safe.example')).toBe('https://safe.example')
    expect(normalizeEndpointUrl('https://user:pass@example.com', 'https://safe.example')).toBe(
      'https://safe.example'
    )
  })

  it('rejects base URLs containing a query or fragment', () => {
    expect(normalizeEndpointUrl('https://example.com/v1?token=bad')).toBe('')
    expect(normalizeEndpointUrl('https://example.com/v1#section')).toBe('')
  })

  it('normalizes every persisted service endpoint', () => {
    expect(normalizeSettings({
      whisperBaseUrl: ' https://WHISPER.example/v1/ ',
      claudeBaseUrl: 'javascript:alert(1)',
      syncBaseUrl: ' http://sync.local:8080/ '
    })).toMatchObject({
      whisperBaseUrl: 'https://whisper.example/v1',
      claudeBaseUrl: '',
      syncBaseUrl: 'http://sync.local:8080'
    })
  })
})
