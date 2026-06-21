package com.tanay.echo.floating

/**
 * Fires once when the mic has been quiet for [silenceMs] after at least one speech frame — the
 * hands-free "stop talking and it ends" behaviour for tap-mode dictation. Pure and deterministic
 * (the caller supplies the clock and the level), so it unit-tests on the JVM with no Android.
 */
class SilenceDetector(
    private val thresholdRms: Float = 0.06f,
    private val silenceMs: Long = 3000,
) {
    private var spoke = false
    private var lastSpeechMs = 0L
    private var fired = false

    /** Clear all state so the same detector can be reused for the next dictation. */
    fun reset() {
        spoke = false
        lastSpeechMs = 0L
        fired = false
    }

    /**
     * Feed one level sample at time [nowMs]. Returns true exactly once — on the first sample taken
     * at least [silenceMs] after the most recent above-threshold (speech) sample.
     */
    fun update(rms: Float, nowMs: Long): Boolean {
        if (fired) return false
        if (rms >= thresholdRms) {
            spoke = true
            lastSpeechMs = nowMs
            return false
        }
        if (!spoke) return false // never cut off before the user has actually said something
        if (nowMs - lastSpeechMs >= silenceMs) {
            fired = true
            return true
        }
        return false
    }
}
