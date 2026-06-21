package com.tanay.echo.floating

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * A compact white audio equalizer for the floating bubble — five rounded bars that rise with
 * [setLevel] plus a gentle per-bar shimmer, drawn on the violet pill. Animates only while
 * [start]ed. The minimal sibling of the desktop overlay's canvas waveform.
 */
class WaveformView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0
) : View(context, attrs, defStyle) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt() }
    private val rect = RectF()
    private val bars = 9
    private var level = 0f
    private var smooth = 0f
    private var phase = 0f
    private var running = false

    fun setLevel(l: Float) {
        level = l.coerceIn(0f, 1f)
    }

    fun start() {
        if (running) return
        running = true
        postInvalidateOnAnimation()
    }

    fun stop() {
        running = false
        level = 0f
        smooth = 0f
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        val slot = w / bars
        val barW = slot * 0.5f
        val mid = (bars - 1) / 2f
        smooth += (level - smooth) * 0.35f
        phase += 0.22f
        for (i in 0 until bars) {
            val cw = 1f - abs(i - mid) / (mid + 0.0001f)
            val shimmer = (sin((phase + i * 0.8f).toDouble()).toFloat() * 0.5f + 0.5f) * 0.45f + 0.55f
            val amp = (0.16f + smooth * 0.95f) * (0.5f + cw * 0.5f) * shimmer
            val bh = max(barW, min(1f, amp) * h * 0.85f)
            val cx = slot * i + slot / 2f
            val left = cx - barW / 2f
            val top = (h - bh) / 2f
            rect.set(left, top, left + barW, top + bh)
            canvas.drawRoundRect(rect, barW / 2f, barW / 2f, paint)
        }
        if (running) postInvalidateOnAnimation()
    }
}
