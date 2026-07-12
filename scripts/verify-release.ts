import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { once } from 'node:events'
import { validateArtifactSet, type ArtifactRecord } from '../src/shared/release-artifacts'

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  stream.on('data', (chunk) => hash.update(chunk))
  await once(stream, 'end')
  return hash.digest('hex')
}

async function main(): Promise<void> {
  const root = process.cwd()
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }
  const version = pkg.version
  const paths = [
    `dist/Echo-${version}-setup.exe`,
    'dist/win-unpacked/Echo.exe',
    'dist/win-unpacked/resources/native/EchoKeyHelper.exe',
    'dist/win-unpacked/resources/native/EchoPasteHelper.exe',
    'dist/win-unpacked/resources/native/EchoSpeechHelper.exe',
    'dist/mac-arm64/Echo.app',
    `dist/Echo-${version}-arm64.dmg`,
    `dist/Echo-${version}-arm64-mac.zip`,
    'android/app/build/outputs/apk/debug/app-debug.apk',
  ]
  const missing = paths.filter((path) => !existsSync(resolve(root, path)))
  if (missing.length) throw new Error(`Missing release artifacts:\n${missing.join('\n')}`)

  const records: ArtifactRecord[] = paths.map((path) => ({
    path,
    fileOutput: execFileSync('file', [resolve(root, path)], { encoding: 'utf8' }),
    signatureValid:
      path.endsWith('.app')
        ? spawnSync('codesign', ['--verify', '--deep', '--strict', resolve(root, path)]).status === 0
        : undefined,
    executableFileOutput:
      path.endsWith('.app')
        ? execFileSync('file', [resolve(root, path, 'Contents/MacOS/Echo')], { encoding: 'utf8' })
        : undefined,
    helperFileOutputs:
      path.endsWith('.app')
        ? [
            'Contents/Resources/native/EchoKeyHelper',
            'Contents/Resources/native/EchoPasteHelper',
            'Contents/Resources/native/EchoSpeechHelper.app/Contents/MacOS/EchoSpeechHelper'
          ].map((helper) => execFileSync('file', [resolve(root, path, helper)], { encoding: 'utf8' }))
        : undefined,
  }))
  const errors = validateArtifactSet(records)
  if (errors.length) throw new Error(errors.join('\n'))

  const checksumPaths = paths.filter((path) => !path.endsWith('.app'))
  const lines: string[] = []
  for (const path of checksumPaths) lines.push(`${await sha256(resolve(root, path))}  ${path}`)
  writeFileSync(resolve(root, 'dist/SHA256SUMS'), `${lines.join('\n')}\n`)
  process.stdout.write(`Verified ${paths.length} release artifacts.\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
