package com.tanay.echo.floating

/**
 * Pure positioning math for the floating bubble's *default* dock (before the user has dragged it).
 * Kept Android-free so the tricky "is this keyboard-top report trustworthy?" decision unit-tests
 * without a device — the part most prone to OEM-specific accessibility quirks.
 */
object BubbleDock {
    /**
     * Bottom inset (px, measured from the screen bottom) that docks the *visible* pill [gapPx] above
     * the soft keyboard's top edge, accounting for the window's transparent [glowPadPx] ring.
     *
     * [keyboardTop] is the IME window's top in screen px as reported by the accessibility API — but
     * that read is unreliable (0, full-window, or mid-animation values happen), and trusting a bad
     * one is exactly what drops the bubble into the middle of the keys. So we trust it only when the
     * implied keyboard height is plausible; otherwise we assume the keyboard fills [fallbackFraction]
     * of the screen, which still clears the keys.
     */
    fun defaultDockInset(
        screenHeight: Int,
        keyboardTop: Int,
        gapPx: Int,
        glowPadPx: Int,
        fallbackFraction: Float,
    ): Int {
        // Trust the report only when the implied keyboard height is plausible — a soft keyboard's top
        // sits in roughly the bottom 20–60% of the screen, so its top edge falls in [0.40H, 0.80H].
        // 0, a full-window read, or a mid-animation value lands outside this band; reject it.
        val lo = (screenHeight * 0.40f).toInt()
        val hi = (screenHeight * 0.80f).toInt()
        val top = if (keyboardTop in lo..hi) keyboardTop
                  else (screenHeight * (1f - fallbackFraction)).toInt()
        return (screenHeight - top + gapPx - glowPadPx).coerceAtLeast(0)
    }
}
