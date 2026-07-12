import { describe, expect, it } from 'vitest'
import { scanTrackedFiles, type TrackedTextFile } from '../scripts/check-tracked-secrets'

function scan(...files: TrackedTextFile[]) {
  return scanTrackedFiles(files)
}

describe('tracked secret scan', () => {
  it('rejects local seed files and generated release artifacts by path', () => {
    const findings = scan(
      { path: 'secrets.local.json', content: '{}' },
      { path: 'android/defaults.local.properties', content: '' },
      { path: 'dist/Echo.dmg', content: '' },
      { path: 'android/app-debug.apk', content: '' },
    )

    expect(findings.map((finding) => finding.rule)).toEqual([
      'local-seed-file',
      'local-seed-file',
      'generated-artifact',
      'generated-artifact',
    ])
  })

  it('detects credential prefixes without returning the credential itself', () => {
    const secret = 'sk-proj-' + 'a'.repeat(24)
    const [finding] = scan({ path: 'src/config.ts', content: `const key = '${secret}'` })

    expect(finding).toMatchObject({ path: 'src/config.ts', line: 1, rule: 'credential-prefix' })
    expect(JSON.stringify(finding)).not.toContain(secret)
  })

  it('rejects private tailnet hosts but permits explicit fixture placeholders', () => {
    const privateHost = `https://${'personal-mini'}.ts.net/v1`
    expect(scan({ path: 'README.md', content: privateHost })).toHaveLength(1)
    expect(scan({ path: 'tests/example.ts', content: 'https://mac.ts.net/v1' })).toEqual([])
    expect(scan({ path: 'README.md', content: 'https://example.ts.net/v1' })).toEqual([])
  })

  it('allows example seed files and ordinary source text', () => {
    expect(
      scan(
        { path: 'secrets.local.json.example', content: '{"whisperApiKey":"YOUR_KEY"}' },
        { path: 'src/main/index.ts', content: 'const label = "Echo"' },
      ),
    ).toEqual([])
  })
})
