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
    expect(workflow).toContain('npm run check:desktop')
    expect(workflow).toContain('cancel-in-progress: true')
  })

  it('tests lints and packages Android with the supported toolchain', () => {
    const workflow = repositoryFile('.github/workflows/android-ci.yml')

    expect(workflow).toContain('distribution: temurin')
    expect(workflow).toContain('java-version: 17')
    expect(workflow).toContain('platforms;android-34')
    expect(workflow).toContain('gradle/actions/setup-gradle@v4')
    expect(workflow).toContain('npm run check:android')
    expect(workflow).toContain('actions/upload-artifact@v4')
    expect(workflow).toContain('app-debug.apk')
    expect(workflow).toContain('lint-results-debug.html')
  })

  it('runs CodeQL for desktop and Android source languages', () => {
    const workflow = repositoryFile('.github/workflows/codeql.yml')

    expect(workflow).toContain('security-events: write')
    expect(workflow).toContain('javascript-typescript')
    expect(workflow).toContain('java-kotlin')
    expect(workflow).toContain('build-mode: manual')
    expect(workflow).toContain(':app:assembleDebug')
    expect(workflow).toContain('github/codeql-action/init@v3')
    expect(workflow).toContain('github/codeql-action/analyze@v3')
    expect(workflow).toContain('schedule:')
  })

  it('keeps npm Gradle and Actions dependencies current without grouping majors', () => {
    const config = repositoryFile('.github/dependabot.yml')

    expect(config).toContain('package-ecosystem: npm')
    expect(config).toContain('package-ecosystem: gradle')
    expect(config).toContain('package-ecosystem: github-actions')
    expect(config.match(/open-pull-requests-limit: 5/g)).toHaveLength(3)
    expect(config).toContain('update-types: [minor, patch]')
    expect(config).not.toContain('update-types: [major, minor, patch]')
  })

  it('documents private vulnerability reporting and Echo data boundaries', () => {
    const policy = repositoryFile('SECURITY.md')

    expect(policy).toContain('Report a vulnerability')
    expect(policy).toContain('privately')
    expect(policy).toContain('three business days')
    expect(policy).toContain('credentials')
    expect(policy).toContain('audio')
    expect(policy).toContain('Application Support/echo')
    expect(policy).toContain('%APPDATA%')
  })

  it('defines tested contribution and pull request standards', () => {
    const guide = repositoryFile('CONTRIBUTING.md')
    const template = repositoryFile('.github/pull_request_template.md')

    for (const text of [guide, template]) {
      expect(text).toContain('npm run check:desktop')
      expect(text).toContain('npm run check:android')
      expect(text).toContain('npm run check:secrets')
      expect(text).toContain('No credentials')
    }
    expect(guide).toContain('test first')
    expect(guide).toContain('No AI attribution')
    expect(template).toContain('macOS')
    expect(template).toContain('Windows')
    expect(template).toContain('Android')
  })
})
