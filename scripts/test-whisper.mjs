// Probe the Whisper transcription endpoint with a given key + 0.3s silence WAV.
// Usage: node scripts/test-whisper.mjs <apiKey> <baseUrl>
const key = process.argv[2]
const base = process.argv[3]
if (!key || !base) {
  console.error('usage: node scripts/test-whisper.mjs <apiKey> <baseUrl>')
  console.error('   eg: node scripts/test-whisper.mjs sk-... https://your-whisper-host/v1')
  process.exit(1)
}
const rate = 16000
const n = Math.round(rate * 0.3)
const buf = Buffer.alloc(44 + n * 2)
buf.write('RIFF', 0)
buf.writeUInt32LE(36 + n * 2, 4)
buf.write('WAVE', 8)
buf.write('fmt ', 12)
buf.writeUInt32LE(16, 16)
buf.writeUInt16LE(1, 20)
buf.writeUInt16LE(1, 22)
buf.writeUInt32LE(rate, 24)
buf.writeUInt32LE(rate * 2, 28)
buf.writeUInt16LE(2, 32)
buf.writeUInt16LE(16, 34)
buf.write('data', 36)
buf.writeUInt32LE(n * 2, 40)

const form = new FormData()
form.append('file', new Blob([buf], { type: 'audio/wav' }), 'a.wav')
form.append('model', 'whisper-1')

const res = await fetch(`${base}/audio/transcriptions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}` },
  body: form
})
console.log('status', res.status)
console.log((await res.text()).slice(0, 400))
