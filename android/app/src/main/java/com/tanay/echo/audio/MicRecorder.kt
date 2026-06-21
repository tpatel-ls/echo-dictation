package com.tanay.echo.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder

/**
 * Pre-warmed 16 kHz mono PCM16 microphone capture — the desktop "keep warm" mic mode for
 * Android. `prime()` opens the mic and starts draining frames *before* the user taps, so the
 * first dictation has no cold-start latency; frames are discarded until `start()`. AudioRecord
 * already yields exactly the PCM16@16k Whisper wants, so the live path needs no float/resample
 * (lowest latency, smallest payload). Android-coupled, so not unit-tested — see WavTest for the
 * encoder it feeds.
 *
 * Not thread-safe across callers; intended to be driven from the IME's single UI thread, with
 * one internal reader thread doing the blocking reads.
 */
class MicRecorder(
    private val sampleRate: Int = TARGET_RATE,
    private val source: Int = MediaRecorder.AudioSource.VOICE_RECOGNITION
) {
    private var record: AudioRecord? = null
    private var reader: Thread? = null
    @Volatile private var running = false
    @Volatile private var capturing = false

    /** Live input level (RMS, 0..1) for the waveform + silence detection. Fires on the reader
     *  thread while capturing — consumers must marshal to their own UI thread. */
    @Volatile var onLevel: (Float) -> Unit = {}

    private val lock = Any()
    private var buffer = ShortArray(sampleRate) // ~1s, grows as needed
    private var size = 0
    private val frameSize: Int = run {
        val min = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min > 0) min / 2 else sampleRate / 10 // shorts, not bytes; ~100ms fallback
    }

    val isPrimed: Boolean get() = running

    /**
     * Open the mic and begin draining frames now (discarded until [start]). Call when the
     * keyboard becomes visible. The caller must hold RECORD_AUDIO; throws if the mic can't open.
     */
    @SuppressLint("MissingPermission") // caller verifies RECORD_AUDIO before priming
    fun prime() {
        if (running) return
        val bufBytes = maxOf(frameSize * 2, AudioRecord.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        ))
        val rec = AudioRecord.Builder()
            .setAudioSource(source)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .build()
            )
            .setBufferSizeInBytes(maxOf(bufBytes, 2 * sampleRate))
            .build()
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            throw IllegalStateException("Microphone unavailable (permission denied or device busy)")
        }
        record = rec
        rec.startRecording()
        running = true
        reader = Thread { readLoop(rec) }.apply { isDaemon = true; start() }
    }

    private fun readLoop(rec: AudioRecord) {
        val frame = ShortArray(frameSize)
        while (running) {
            val n = rec.read(frame, 0, frame.size)
            if (n > 0 && capturing) {
                append(frame, n)
                onLevel(rmsLevel(frame, n))
            }
        }
    }

    /** Normalized RMS (0..1) of the first [n] PCM16 samples in [frame]. */
    private fun rmsLevel(frame: ShortArray, n: Int): Float {
        if (n <= 0) return 0f
        var sum = 0.0
        for (i in 0 until n) {
            val s = frame[i].toDouble()
            sum += s * s
        }
        return (Math.sqrt(sum / n) / 32768.0).toFloat().coerceIn(0f, 1f)
    }

    private fun append(frame: ShortArray, n: Int) {
        synchronized(lock) {
            if (size + n > buffer.size) {
                var cap = buffer.size * 2
                while (cap < size + n) cap *= 2
                buffer = buffer.copyOf(cap)
            }
            System.arraycopy(frame, 0, buffer, size, n)
            size += n
        }
    }

    /** Start accumulating audio. The mic is already warm, so capture begins immediately. */
    fun start() {
        synchronized(lock) { size = 0 }
        capturing = true
    }

    /** Stop accumulating and return the captured 16 kHz mono PCM16 samples. */
    fun stop(): ShortArray {
        capturing = false
        return synchronized(lock) { buffer.copyOf(size) }
    }

    /** Release the mic and stop the reader thread. Call when the keyboard is hidden/destroyed. */
    fun release() {
        capturing = false
        running = false
        reader?.join(500)
        reader = null
        record?.let {
            try {
                it.stop()
            } catch (_: IllegalStateException) {
                /* never started */
            }
            it.release()
        }
        record = null
    }
}
