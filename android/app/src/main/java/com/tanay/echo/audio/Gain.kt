package com.tanay.echo.audio

import kotlin.math.abs

/**
 * Amplify quiet PCM so whispered / soft speech still transcribes (Whisper Mode). Scales the signal
 * so its loudest sample reaches [targetPeak], but only ever amplifies (never quieter) and caps the
 * gain at [maxGain] so a near-silent clip's noise floor isn't blown up. Silence is returned as-is.
 * Pure + JVM-testable.
 */
fun boostGain(pcm: ShortArray, targetPeak: Int = 22000, maxGain: Float = 16f): ShortArray {
    var peak = 0
    for (s in pcm) {
        val a = abs(s.toInt())
        if (a > peak) peak = a
    }
    if (peak == 0) return pcm // silence — nothing to boost
    val factor = (targetPeak.toFloat() / peak).coerceIn(1f, maxGain) // only amplify, capped
    if (factor == 1f) return pcm
    return ShortArray(pcm.size) { i -> (pcm[i] * factor).toInt().coerceIn(-32768, 32767).toShort() }
}
