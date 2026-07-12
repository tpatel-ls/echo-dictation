import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('release package scripts', () => {
  it('pins Windows packaging to x64 so Electron and native helpers match', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(pkg.scripts.pack).toContain('electron-builder --win --x64 --dir')
    expect(pkg.scripts.dist).toContain('electron-builder --win --x64')
  })

  it('installs Windows machine-wide and registers all-user hidden startup', () => {
    const builder = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    const installer = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')

    expect(builder).toContain('perMachine: true')
    expect(builder).toContain('include: build/installer.nsh')
    expect(installer).toContain('Software\\Microsoft\\Windows\\CurrentVersion\\Run')
    expect(installer).toContain('--hidden')
  })
})
