import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export interface TrackedTextFile {
  path: string
  content: string
}

export interface SecretFinding {
  path: string
  line: number
  rule: 'local-seed-file' | 'generated-artifact' | 'credential-prefix' | 'private-tailnet-host'
}

const localSeedPaths = new Set(['secrets.local.json', 'android/defaults.local.properties'])
const allowedTailnetFixtures = new Set(['example', 'mac', 'your-host', 'your-mac-mini'])
const credentialPattern =
  /(?:sk-(?:ant|proj|live)-[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|tskey-[A-Za-z0-9_-]{10,})/g
const tailnetPattern = /\b([a-z0-9-]+)\.ts\.net\b/gi

function generatedArtifact(path: string): boolean {
  return /^(?:dist|out)\//.test(path) || /\.(?:apk|dmg|exe|blockmap)$/i.test(path)
}

export function scanTrackedFiles(files: TrackedTextFile[]): SecretFinding[] {
  const findings: SecretFinding[] = []

  for (const file of files) {
    if (localSeedPaths.has(file.path)) {
      findings.push({ path: file.path, line: 1, rule: 'local-seed-file' })
      continue
    }
    if (generatedArtifact(file.path)) {
      findings.push({ path: file.path, line: 1, rule: 'generated-artifact' })
      continue
    }
    if (file.content.includes('\0')) continue

    for (const [index, line] of file.content.split(/\r?\n/).entries()) {
      credentialPattern.lastIndex = 0
      if (credentialPattern.test(line)) {
        findings.push({ path: file.path, line: index + 1, rule: 'credential-prefix' })
      }

      tailnetPattern.lastIndex = 0
      for (const match of line.matchAll(tailnetPattern)) {
        const host = match[1]?.toLowerCase() ?? ''
        if (!allowedTailnetFixtures.has(host)) {
          findings.push({ path: file.path, line: index + 1, rule: 'private-tailnet-host' })
        }
      }
    }
  }

  return findings
}

function trackedFiles(): TrackedTextFile[] {
  const output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  return output
    .split('\0')
    .filter(Boolean)
    .map((path) => {
      try {
        return { path, content: readFileSync(path, 'utf8') }
      } catch {
        return { path, content: '\0' }
      }
    })
}

function main(): void {
  const findings = scanTrackedFiles(trackedFiles())
  if (!findings.length) {
    process.stdout.write('Tracked secret scan passed.\n')
    return
  }

  for (const finding of findings) {
    process.stderr.write(`${finding.path}:${finding.line} [${finding.rule}]\n`)
  }
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
