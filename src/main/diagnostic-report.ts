import type { DiagResult, TriggerKey } from '@shared/types'
import type { BuildInfo } from '@shared/build-info'

export interface DiagnosticReportInput {
  platform: NodeJS.Platform
  arch: string
  packaged: boolean
  triggerKey: TriggerKey
  hotkeyRunning: boolean
  endpoints: { whisper: boolean; cleanup: boolean; sync: boolean }
  secrets: { whisper: boolean; cleanup: boolean; sync: boolean }
  results: DiagResult[]
  build?: BuildInfo
}

export function redactDiagnosticText(text: string): string {
  return text
    .replace(/\/Users\/[^/\s]+/gi, '~')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, '~')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/https?:\/\/[^\s"')]+/gi, '[url]')
}

export function createDiagnosticReport(input: DiagnosticReportInput): string {
  const yesNo = (value: boolean): string => value ? 'yes' : 'no'
  const lines = [
    'Echo diagnostics',
    `Generated: ${new Date().toISOString()}`,
    `Platform: ${input.platform} ${input.arch}`,
    ...(input.build ? [`Build: ${input.build.appVersion} ${input.build.runtime} ${input.build.channel}`] : []),
    `Packaged: ${yesNo(input.packaged)}`,
    `Trigger: ${input.triggerKey}`,
    `Hotkey running: ${yesNo(input.hotkeyRunning)}`,
    `Endpoints: whisper=${yesNo(input.endpoints.whisper)} cleanup=${yesNo(input.endpoints.cleanup)} sync=${yesNo(input.endpoints.sync)}`,
    `Credentials: whisper=${yesNo(input.secrets.whisper)} cleanup=${yesNo(input.secrets.cleanup)} sync=${yesNo(input.secrets.sync)}`,
    '',
    'Checks:'
  ]
  for (const result of input.results) {
    const elapsed = result.ms === undefined ? '' : ` (${result.ms}ms)`
    lines.push(`${result.name}: ${result.ok ? 'ok' : 'failed'}${elapsed} - ${result.detail}`)
  }
  if (!input.results.length) lines.push('No checks run yet.')
  return redactDiagnosticText(lines.join('\n'))
}
