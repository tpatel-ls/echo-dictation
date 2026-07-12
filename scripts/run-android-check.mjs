import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
const env = { ...process.env }
if (process.platform === 'darwin' && !env.JAVA_HOME) {
  for (const candidate of [
    '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    '/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
  ]) {
    if (existsSync(join(candidate, 'bin', 'java'))) {
      env.JAVA_HOME = candidate
      break
    }
  }
}
if (process.platform === 'darwin' && !env.ANDROID_HOME) {
  const candidate = '/opt/homebrew/share/android-commandlinetools'
  if (existsSync(candidate)) env.ANDROID_HOME = candidate
}
const result = spawnSync(
  wrapper,
  ['testDebugUnitTest', 'lintDebug', 'assembleDebug', '--no-daemon'],
  { cwd: join(root, 'android'), env, stdio: 'inherit', shell: process.platform === 'win32' },
)

process.exit(result.status ?? 1)
