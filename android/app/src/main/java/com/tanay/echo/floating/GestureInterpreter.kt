package com.tanay.echo.floating

/** What a touch on the floating button resolved to. */
sealed interface Gesture {
    /** A quick press-release — toggles hands-free tap mode. */
    data object Tap : Gesture

    /** A long-press began — start push-to-talk capture. */
    data object HoldStart : Gesture

    /** The long-press ended (finger lifted) — stop and transcribe. */
    data object HoldEnd : Gesture

    /** The bubble is being dragged — reposition by ([dx], [dy]) since the last move. */
    data class Drag(val dx: Float, val dy: Float) : Gesture
}

/**
 * Pure classifier for the floating button's touches. Android only delivers ACTION_MOVE when the
 * finger actually moves, so a still press-and-hold would never trip a move-based long-press — the
 * host therefore schedules a long-press timer (a Handler) and calls [holdTimerFired]. This class
 * owns the tap/hold/drag decision so it unit-tests without a Looper.
 *
 * State machine from [down]: a MOVE past [touchSlopPx] ⇒ Drag (and cancels any pending hold); the
 * host's timer ⇒ HoldStart (only if still a clean, undragged press); [up] ⇒ HoldEnd if holding,
 * nothing if it was a drag, else Tap.
 */
class GestureInterpreter(private val touchSlopPx: Float = 16f) {
    private var downX = 0f
    private var downY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var pressed = false
    private var holding = false
    private var dragging = false

    fun down(x: Float, y: Float) {
        downX = x; downY = y; lastX = x; lastY = y
        pressed = true; holding = false; dragging = false
    }

    /** Called when the host's long-press timer elapses. HoldStart only if still a clean press. */
    fun holdTimerFired(): Gesture? {
        if (pressed && !dragging && !holding) {
            holding = true
            return Gesture.HoldStart
        }
        return null
    }

    fun move(x: Float, y: Float): Gesture? {
        if (!pressed) return null
        val dx = x - lastX
        val dy = y - lastY
        lastX = x; lastY = y
        if (!dragging && !holding && dist(x, y, downX, downY) > touchSlopPx) dragging = true
        return if (dragging) Gesture.Drag(dx, dy) else null
    }

    fun up(): Gesture? {
        pressed = false
        return when {
            holding -> { holding = false; Gesture.HoldEnd }
            dragging -> { dragging = false; null }
            else -> Gesture.Tap
        }
    }

    private fun dist(x1: Float, y1: Float, x2: Float, y2: Float): Float =
        Math.hypot((x1 - x2).toDouble(), (y1 - y2).toDouble()).toFloat()
}
