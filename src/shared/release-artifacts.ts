export type ArtifactKind =
  | 'windows-installer'
  | 'windows-runtime'
  | 'windows-helper'
  | 'mac-app'
  | 'mac-dmg'
  | 'mac-zip'
  | 'android-apk'

export interface ArtifactRecord {
  path: string
  fileOutput: string
  signatureValid?: boolean
  executableFileOutput?: string
  helperFileOutputs?: string[]
}

export function classifyArtifact(path: string): ArtifactKind | null {
  const normalized = path.replaceAll('\\', '/')
  if (/\/Echo-[^/]+-setup\.exe$/i.test(`/${normalized}`)) return 'windows-installer'
  if (/\/win-unpacked\/Echo\.exe$/i.test(`/${normalized}`)) return 'windows-runtime'
  if (/\/win-unpacked\/resources\/native\/Echo(?:Key|Paste|Speech)Helper\.exe$/i.test(`/${normalized}`)) {
    return 'windows-helper'
  }
  if (/\/mac-arm64\/Echo\.app$/i.test(`/${normalized}`)) return 'mac-app'
  if (/\/Echo-[^/]+-arm64\.dmg$/i.test(`/${normalized}`)) return 'mac-dmg'
  if (/\/Echo-[^/]+-arm64-mac\.zip$/i.test(`/${normalized}`)) return 'mac-zip'
  if (/\/android\/app\/build\/outputs\/apk\/debug\/app-debug\.apk$/i.test(`/${normalized}`)) return 'android-apk'
  return null
}

export function validateArtifactSet(records: ArtifactRecord[]): string[] {
  const errors: string[] = []
  const bySuffix = (suffix: string) =>
    records.find((record) => `/${record.path.replaceAll('\\', '/')}`.endsWith(suffix))
  const requiredSuffixes = [
    '-setup.exe',
    '/win-unpacked/Echo.exe',
    '/win-unpacked/resources/native/EchoKeyHelper.exe',
    '/win-unpacked/resources/native/EchoPasteHelper.exe',
    '/win-unpacked/resources/native/EchoSpeechHelper.exe',
    '/mac-arm64/Echo.app',
    '-arm64.dmg',
    '-arm64-mac.zip',
    '/android/app/build/outputs/apk/debug/app-debug.apk',
  ]

  for (const suffix of requiredSuffixes) {
    if (!bySuffix(suffix)) errors.push(`Missing release artifact matching ${suffix}`)
  }

  for (const record of records) {
    const kind = classifyArtifact(record.path)
    if ((kind === 'windows-runtime' || kind === 'windows-helper') && !/x86-64/i.test(record.fileOutput)) {
      errors.push(`Windows runtime must be x86-64: ${record.path}`)
    }
    if (kind === 'windows-installer' && !/Nullsoft|NSIS/i.test(record.fileOutput)) {
      errors.push(`Windows installer is not an NSIS executable: ${record.path}`)
    }
    if (kind === 'mac-app' && record.signatureValid !== true) {
      errors.push(`macOS signature verification failed: ${record.path}`)
    }
    if (kind === 'mac-app' && !/arm64/i.test(record.executableFileOutput ?? '')) {
      errors.push(`macOS executable must be arm64: ${record.path}`)
    }
    if (
      kind === 'mac-app' &&
      (record.helperFileOutputs?.length !== 3 || record.helperFileOutputs.some((output) => !/arm64/i.test(output)))
    ) {
      errors.push(`macOS native helpers must be arm64: ${record.path}`)
    }
    if ((kind === 'mac-zip' || kind === 'android-apk') && !/Zip archive/i.test(record.fileOutput)) {
      errors.push(`Expected a Zip-compatible artifact: ${record.path}`)
    }
  }

  return errors
}
