import { posix, win32 } from 'node:path'

export type NativeHelperName = 'EchoKeyHelper' | 'EchoPasteHelper' | 'EchoSpeechHelper'

export function helperPath(
  name: NativeHelperName,
  platform: NodeJS.Platform = process.platform,
  resourcesPath?: string,
  cwd = process.cwd()
): string {
  const paths = platform === 'win32' ? win32 : posix
  const base = resourcesPath ? paths.join(resourcesPath, 'native') : paths.join(cwd, 'out', 'native')

  if (platform === 'win32') return paths.join(base, `${name}.exe`)
  if (platform === 'darwin' && name === 'EchoSpeechHelper') {
    return paths.join(base, 'EchoSpeechHelper.app', 'Contents', 'MacOS', 'EchoSpeechHelper')
  }
  return paths.join(base, name)
}
