package com.tanay.echo.audio

import java.nio.ByteBuffer
import java.nio.ByteOrder

// Pure PCM → WAV encoder. A faithful Kotlin port of src/shared/wav.ts so desktop and phone
// produce byte-identical 16 kHz mono 16-bit payloads. No Android APIs → unit-testable on a
// plain JVM (see WavTest). The live mic path uses pcm16ToWav (AudioRecord already gives
// PCM16@16k); floatToWav/resampleLinear exist for parity and share the same header writer.

const val TARGET_RATE = 16000

/** Mic frames (Float32 at device rate) → 16 kHz mono 16-bit WAV. */
fun encodeWav(frames: List<FloatArray>, inputRate: Int): ByteArray {
    val mono = mergeFrames(frames)
    val resampled = if (inputRate == TARGET_RATE) mono else resampleLinear(mono, inputRate, TARGET_RATE)
    return floatToWav(resampled, TARGET_RATE)
}

fun mergeFrames(frames: List<FloatArray>): FloatArray {
    val len = frames.sumOf { it.size }
    val out = FloatArray(len)
    var off = 0
    for (f in frames) {
        f.copyInto(out, off)
        off += f.size
    }
    return out
}

fun resampleLinear(input: FloatArray, from: Int, to: Int): FloatArray {
    if (from == to) return input
    val ratio = from.toDouble() / to.toDouble()
    val outLen = maxOf(1, Math.floor(input.size / ratio).toInt())
    val out = FloatArray(outLen)
    for (i in 0 until outLen) {
        val pos = i * ratio
        val i0 = Math.floor(pos).toInt()
        val i1 = minOf(i0 + 1, input.size - 1)
        val frac = pos - i0
        out[i] = (input[i0] * (1 - frac) + input[i1] * frac).toFloat()
    }
    return out
}

/** Float32 [-1, 1] → mono 16-bit PCM WAV. */
fun floatToWav(samples: FloatArray, rate: Int): ByteArray = wavBytes(floatToPcm16(samples), rate)

/** Already-16-bit PCM (straight from AudioRecord) → WAV with no conversion — the live path. */
fun pcm16ToWav(samples: ShortArray, rate: Int): ByteArray = wavBytes(samples, rate)

private fun floatToPcm16(samples: FloatArray): ShortArray {
    val out = ShortArray(samples.size)
    for (i in samples.indices) {
        var s = samples[i]
        if (s > 1f) s = 1f else if (s < -1f) s = -1f
        // Mirror the desktop: negatives scale by 0x8000, non-negatives by 0x7fff.
        out[i] = (if (s < 0) s * 0x8000 else s * 0x7fff).toInt().toShort()
    }
    return out
}

private fun wavBytes(samples: ShortArray, rate: Int): ByteArray {
    val bytesPerSample = 2
    val blockAlign = bytesPerSample // mono
    val dataSize = samples.size * bytesPerSample
    val buf = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN)
    putAscii(buf, "RIFF")
    buf.putInt(36 + dataSize)
    putAscii(buf, "WAVE")
    putAscii(buf, "fmt ")
    buf.putInt(16) // fmt chunk size
    buf.putShort(1.toShort()) // audio format = PCM
    buf.putShort(1.toShort()) // channels = mono
    buf.putInt(rate) // sample rate
    buf.putInt(rate * blockAlign) // byte rate
    buf.putShort(blockAlign.toShort())
    buf.putShort(16.toShort()) // bits per sample
    putAscii(buf, "data")
    buf.putInt(dataSize)
    for (s in samples) buf.putShort(s)
    return buf.array()
}

private fun putAscii(buf: ByteBuffer, s: String) {
    for (c in s) buf.put(c.code.toByte())
}
