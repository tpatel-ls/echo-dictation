// Generates build/icon.png (256) and build/tray.png (32) with no image deps:
// a gradient disc with a 3-bar waveform — the Echo mark. Hand-rolled PNG encoder.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function crc32(buf) {
  let c = ~0 >>> 0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (~c) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))
const lerp = (a, b, t) => a + (b - a) * t

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const cx = (size - 1) / 2
  const cy = (size - 1) / 2
  const R = size * 0.46
  const a1 = [0x63, 0x66, 0xf1]
  const a2 = [0x4f, 0x46, 0xe5]
  const white = [0xee, 0xf0, 0xff]
  const bars = [
    { dx: -0.34, h: 0.32 },
    { dx: 0.0, h: 0.54 },
    { dx: 0.34, h: 0.32 }
  ]
  const barW = size * 0.1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const dx = x - cx
      const dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist > R + 1) continue
      const t = (x + y) / (2 * size)
      let col = [lerp(a1[0], a2[0], t), lerp(a1[1], a2[1], t), lerp(a1[2], a2[2], t)]
      let alpha = dist > R - 1.5 ? clamp(255 * (R - dist + 1.5) / 1.5) : 255
      for (const b of bars) {
        const bx = cx + b.dx * R
        const hh = b.h * R
        if (Math.abs(x - bx) <= barW / 2 && Math.abs(y - cy) <= hh) col = white
      }
      rgba[i] = clamp(col[0])
      rgba[i + 1] = clamp(col[1])
      rgba[i + 2] = clamp(col[2])
      rgba[i + 3] = alpha
    }
  }
  return encodePng(size, rgba)
}

mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build', 'icon.png'), draw(256))
writeFileSync(join(root, 'build', 'tray.png'), draw(32))
console.log('wrote build/icon.png (256) and build/tray.png (32)')
