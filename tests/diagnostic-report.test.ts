import { describe, expect, it } from 'vitest'
import { createDiagnosticReport, redactDiagnosticText } from '../src/main/diagnostic-report'

describe('redactDiagnosticText', () => {
  it('removes URLs, home-directory names, bearer values, and API-key-like tokens', () => {
    const input =
      'GET https://proxy.example/v1 failed for /Users/tanay/Library/Echo ' +
      'Bearer top-secret-value sk-test_12345678901234567890 C:\\Users\\Tanay\\Echo'
    const output = redactDiagnosticText(input)

    expect(output).not.toContain('proxy.example')
    expect(output).not.toContain('tanay')
    expect(output).not.toContain('top-secret-value')
    expect(output).not.toContain('sk-test')
    expect(output).toContain('[url]')
    expect(output).toContain('~/Library/Echo')
  })
})

describe('createDiagnosticReport', () => {
  it('emits useful configuration state without endpoint or secret values', () => {
    const report = createDiagnosticReport({
      platform: 'darwin',
      arch: 'arm64',
      packaged: true,
      triggerKey: 'RightOption',
      hotkeyRunning: true,
      endpoints: { whisper: true, cleanup: true, sync: false },
      secrets: { whisper: true, cleanup: true, sync: false },
      results: [{ name: 'whisper', ok: false, detail: 'Failed at https://private.example/v1', ms: 25 }]
    })

    expect(report).toContain('Platform: darwin arm64')
    expect(report).toContain('Trigger: RightOption')
    expect(report).toContain('Endpoints: whisper=yes cleanup=yes sync=no')
    expect(report).toContain('whisper: failed (25ms) - Failed at [url]')
    expect(report).not.toContain('private.example')
  })
})
