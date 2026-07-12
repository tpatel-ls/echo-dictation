import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkToolchain } from '../scripts/check-toolchain.mjs'

describe('toolchain preflight', () => {
  it('accepts supported current and LTS toolchains', () => {
    expect(checkToolchain({ node: 'v20.18.0', npm: '10.8.0' })).toEqual([])
    expect(checkToolchain({ node: '22.12.0', npm: '11.0.0' })).toEqual([])
    expect(checkToolchain({ node: '25.5.0', npm: '11.8.0' })).toEqual([])
  })

  it('returns actionable issues for old or malformed versions', () => {
    expect(checkToolchain({ node: 'v18.20.0', npm: '9.9.0' })).toEqual([
      'Node.js 20 or newer is required; found v18.20.0.',
      'npm 10 or newer is required; found 9.9.0.',
    ])
    expect(checkToolchain({ node: 'unknown', npm: '' })).toEqual([
      'Could not determine the Node.js version (unknown).',
      'Could not determine the npm version.',
    ])
  })

  it('declares the enforced versions in package metadata', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      engines?: Record<string, string>
      packageManager?: string
      description?: string
    }

    expect(pkg.engines).toEqual({ node: '>=20', npm: '>=10' })
    expect(pkg.packageManager).toMatch(/^npm@11\./)
    expect(pkg.description).toContain('macOS, Windows x64, and Android')
  })
})
