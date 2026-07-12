import { describe, expect, it } from 'vitest'
import { validateEndpointUrl } from '../src/shared/endpoints'

describe('validateEndpointUrl', () => {
  it('requires the Whisper endpoint while allowing empty optional endpoints', () => {
    expect(validateEndpointUrl('', { required: true, label: 'Whisper' }).error).toBe(
      'Whisper endpoint is required.'
    )
    expect(validateEndpointUrl('   ', { required: false }).error).toBeNull()
  })

  it('accepts and normalizes HTTPS and tailnet or local HTTP endpoints', () => {
    expect(validateEndpointUrl(' HTTPS://Proxy.Example/v1/ ', { required: true })).toEqual({
      normalized: 'https://proxy.example/v1',
      error: null
    })
    expect(validateEndpointUrl('http://mac.local:8787/', { required: true }).error).toBeNull()
  })

  it('returns field-ready errors for malformed schemes and embedded credentials', () => {
    expect(validateEndpointUrl('proxy.example/v1', { required: true }).error).toMatch(/http/i)
    expect(validateEndpointUrl('ftp://proxy.example', { required: true }).error).toMatch(/HTTP/)
    expect(validateEndpointUrl('https://user:pass@proxy.example', { required: true }).error).toMatch(
      /credentials/i
    )
  })

  it('rejects query strings and fragments on base URLs', () => {
    expect(validateEndpointUrl('https://proxy.example?v=1').error).toMatch(/query/i)
    expect(validateEndpointUrl('https://proxy.example#v1').error).toMatch(/fragment/i)
  })
})
