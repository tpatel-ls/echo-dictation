import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const venv = join(root, '.venv-speech')
const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const env = { ...process.env, ECHO_MODEL_CACHE: process.env.ECHO_MODEL_CACHE || join(root, '.models') }
const action = process.argv[2] || 'start'

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

if (action === 'setup') {
  const candidates = process.env.ECHO_PYTHON ? [[process.env.ECHO_PYTHON, []]]
    : [['python3', []], ['python', []], ...(process.platform === 'win32' ? [['py', ['-3.12']], ['py', ['-3.11']]] : [])]
  if (!existsSync(python)) {
    const selected = candidates.find(([command, args]) => spawnSync(command,
      [...args, '-c', 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 12) else 1)'],
      { windowsHide: true, stdio: 'ignore' }).status === 0)
    if (!selected) throw new Error('Install Python 3.12 (64-bit) and add it to PATH, then rerun npm run setup:local. ECHO_PYTHON can specify its executable.')
    run(selected[0], [...selected[1], '-m', 'venv', venv])
  }
  run(python, ['-m', 'pip', 'install', '-r', join(root, 'local-speech', 'requirements.txt')])
  run(python, ['-c', "import sys; sys.path.insert(0, 'local-speech'); from server import load_model; load_model(); print('Local speech model downloaded and ready.')"])
  const seed = join(root, 'secrets.local.json')
  if (!existsSync(seed)) writeFileSync(seed, JSON.stringify({ whisperBaseUrl: `http://127.0.0.1:${env.ECHO_SPEECH_PORT || '8178'}/v1` }, null, 2), { mode: 0o600 })
  else console.log('Existing secrets.local.json kept. For local speech, set the URL shown below in Echo Settings.')
  console.log('Run npm run speech:start in one terminal and npm run dev in another. Local URL: http://127.0.0.1:8178/v1; model: whisper-1; no API key.')
} else if (action === 'start') {
  if (!existsSync(python)) throw new Error('Run npm run setup:local first.')
  const child = spawn(python, [join(root, 'local-speech', 'server.py')], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code || 0 })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
} else if (action === 'check') {
  const base = `http://127.0.0.1:${env.ECHO_SPEECH_PORT || '8178'}`
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
  const body = await res.json()
  if (!res.ok || body.status !== 'ready') throw new Error('Local speech model is not ready.')
  console.log(`Speech ready: ${body.model} (${body.device}), ${base}/v1`)
} else throw new Error(`Unknown action: ${action}`)
