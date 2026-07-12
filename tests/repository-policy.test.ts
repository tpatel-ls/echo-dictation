import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

function repositoryFile(path: string): string {
  const absolute = join(root, path)
  expect(existsSync(absolute), `expected ${path} to exist`).toBe(true)
  return readFileSync(absolute, 'utf8')
}

describe('repository automation policy', () => {
  it('verifies desktop code and native builds on every supported desktop platform', () => {
    const workflow = repositoryFile('.github/workflows/desktop-ci.yml')

    expect(workflow).toContain('ubuntu-latest')
    expect(workflow).toContain('macos-15')
    expect(workflow).toContain('windows-2025')
    expect(workflow).toContain('npm test')
    expect(workflow).toContain('npm run typecheck')
    expect(workflow).toContain('npm run build')
    expect(workflow).toContain('npm run build:win')
    expect(workflow).toContain('cancel-in-progress: true')
  })
})
