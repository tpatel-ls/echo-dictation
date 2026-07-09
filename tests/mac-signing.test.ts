import { describe, expect, it } from 'vitest'
// @ts-expect-error Node installer helpers are ESM scripts without TS declarations.
import { codesignArgs, findIdentityHash, hasAdhocSignature } from '../scripts/mac-signing.mjs'

describe('mac signing helpers', () => {
  const identity = 'Echo Local Code Signing'

  it('finds a named signing identity in security output', () => {
    const out = '  1) ABCDEF1234567890 "Echo Local Code Signing"\n     1 valid identities found\n'
    expect(findIdentityHash(out, identity)).toBe('ABCDEF1234567890')
  })

  it('does not match a different signing identity', () => {
    const out = '  1) ABCDEF1234567890 "Other App Signing"\n     1 valid identities found\n'
    expect(findIdentityHash(out, identity)).toBeNull()
  })

  it('uses the stable identity when available instead of ad-hoc signing', () => {
    expect(codesignArgs('/Applications/Echo.app', identity)).toEqual([
      '--force',
      '--deep',
      '--options',
      'runtime',
      '--sign',
      identity,
      '/Applications/Echo.app'
    ])
  })

  it('detects ad-hoc signatures from codesign details', () => {
    expect(hasAdhocSignature('Signature=adhoc\nIdentifier=com.tanay.echo')).toBe(true)
    expect(hasAdhocSignature('Authority=Echo Local Code Signing\nIdentifier=com.tanay.echo')).toBe(false)
  })
})
