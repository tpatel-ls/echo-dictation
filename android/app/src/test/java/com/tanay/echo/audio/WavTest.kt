package com.tanay.echo.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

// Mirrors tests/wav.test.ts. Authored on the desktop (no Android toolchain there) — runs on
// your machine via `./gradlew test`. Same expected bytes as the passing TS suite.
class WavTest {
    private fun le(bytes: ByteArray) = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    private fun str(bytes: ByteArray, off: Int, len: Int) = String(bytes, off, len, Charsets.US_ASCII)

    @Test
    fun writesValidHeaderForMono16Bit() {
        val samples = floatArrayOf(0f, 0.5f, -0.5f, 1f, -1f)
        val bytes = floatToWav(samples, 16000)
        val v = le(bytes)
        assertEquals("RIFF", str(bytes, 0, 4))
        assertEquals("WAVE", str(bytes, 8, 4))
        assertEquals("fmt ", str(bytes, 12, 4))
        assertEquals(1, v.getShort(20).toInt()) // PCM
        assertEquals(1, v.getShort(22).toInt()) // mono
        assertEquals(16000, v.getInt(24))
        assertEquals(16, v.getShort(34).toInt()) // bits per sample
        assertEquals("data", str(bytes, 36, 4))
        assertEquals(samples.size * 2, v.getInt(40))
        assertEquals(44 + samples.size * 2, bytes.size)
    }

    @Test
    fun clampsSamplesBeyondRange() {
        val v = le(floatToWav(floatArrayOf(2f, -2f), 16000))
        assertEquals(0x7fff.toShort(), v.getShort(44))
        assertEquals((-0x8000).toShort(), v.getShort(46))
    }

    @Test
    fun resampleReturnsInputUnchangedWhenRatesMatch() {
        val input = floatArrayOf(0.1f, 0.2f, 0.3f)
        assertSame(input, resampleLinear(input, 16000, 16000))
    }

    @Test
    fun downsamples48kTo16k() {
        val input = FloatArray(300) { 0.5f }
        val out = resampleLinear(input, 48000, 16000)
        assertEquals(100, out.size)
        assertEquals(0.5f, out[50], 1e-5f)
    }

    @Test
    fun encodeWavProduces16kRegardlessOfInputRate() {
        val frame = FloatArray(4800) { 0.25f } // 0.1s @ 48k
        val v = le(encodeWav(listOf(frame), 48000))
        assertEquals(16000, v.getInt(24))
        assertEquals(1600 * 2, v.getInt(40)) // ~1600 samples
    }

    @Test
    fun encodeWavConcatenatesFrames() {
        val a = FloatArray(1600) { 0.1f }
        val b = FloatArray(1600) { 0.2f }
        assertEquals(3200 * 2, le(encodeWav(listOf(a, b), 16000)).getInt(40))
    }

    @Test
    fun pcm16ToWavWritesRawSamples() {
        val v = le(pcm16ToWav(shortArrayOf(0, 1000, -1000), 16000))
        assertEquals(3 * 2, v.getInt(40))
        assertEquals(1000.toShort(), v.getShort(46))
        assertEquals((-1000).toShort(), v.getShort(48))
    }
}
