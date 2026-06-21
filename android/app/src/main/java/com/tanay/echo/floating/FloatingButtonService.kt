package com.tanay.echo.floating

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import android.widget.Toast
import androidx.core.app.NotificationCompat
import com.tanay.echo.R
import com.tanay.echo.ime.DictationController
import com.tanay.echo.ime.DictationPhase
import com.tanay.echo.settings.EchoSettings

/**
 * A system-wide floating mic button. Hosts the bubble in a non-focusable WindowManager overlay (so
 * the app underneath keeps its text-field focus) and reuses the IME's DictationController, routing
 * transcribed text through the accessibility service to paste into whatever field is focused.
 *
 * Visible only while a soft keyboard is up (the accessibility service reports show/hide). Anchored
 * to the screen's right edge so the wide recording pill grows leftward and never runs off-screen.
 * Tap = hands-free record (stops on a 2nd tap or after silence); press-and-hold = push-to-talk;
 * drag = reposition. Runs as a microphone foreground service so it can capture while another app is
 * in front; started from Settings (a foreground context) per Android 14 rules; not START_STICKY.
 */
class FloatingButtonService : Service() {
    private lateinit var windowManager: WindowManager
    private lateinit var controller: DictationController
    private lateinit var settings: EchoSettings
    private val main = Handler(Looper.getMainLooper())

    private lateinit var bubble: View
    private lateinit var lp: WindowManager.LayoutParams
    private lateinit var idleIcon: ImageView
    private lateinit var waveform: WaveformView
    private lateinit var stopIcon: ImageView

    private val interp = GestureInterpreter()
    private val silence = SilenceDetector()
    private val longPressMs = 280L

    private enum class Mode { NONE, TAP, HOLD }
    private var mode = Mode.NONE
    private var transcribing = false

    private var dragStartLpX = 0
    private var dragStartLpY = 0
    private var dragStartRawX = 0f
    private var dragStartRawY = 0f
    private var movedDuringDrag = false

    private val holdRunnable = Runnable {
        if (interp.holdTimerFired() is Gesture.HoldStart) onHoldStart()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        settings = EchoSettings(this)
        controller = DictationController(this)
        controller.onPhase = { phase, msg -> main.post { updateBubble(phase, msg) } }
        controller.onText = { text -> main.post { deliver(text) } }
        controller.onLevel = { level -> main.post { onLevel(level) } }
        if (!startInForeground()) {
            settings.floatingEnabled = false
            stopSelf()
            return
        }
        if (!addBubble()) {
            toast(getString(R.string.floating_overlay_failed))
            settings.floatingEnabled = false
            stopSelf()
            return
        }
        // Show the bubble only while a keyboard is up; reflect the current state immediately.
        EchoAccessibilityService.visibilityListener = { open -> main.post { setBubbleVisible(open) } }
        setBubbleVisible(EchoAccessibilityService.instance?.isKeyboardOpen() ?: false)
        controller.triggerSync() // pull the latest dictionary so corrections are current
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

    override fun onDestroy() {
        EchoAccessibilityService.visibilityListener = null
        main.removeCallbacksAndMessages(null)
        if (::controller.isInitialized) controller.dispose()
        if (::bubble.isInitialized) runCatching { windowManager.removeView(bubble) }
        super.onDestroy()
    }

    // ── Foreground service ─────────────────────────────────────────────────────────
    private fun startInForeground(): Boolean {
        return try {
            val channelId = "echo_floating"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = getSystemService(NotificationManager::class.java)
                if (nm.getNotificationChannel(channelId) == null) {
                    nm.createNotificationChannel(
                        NotificationChannel(channelId, getString(R.string.floating_channel), NotificationManager.IMPORTANCE_LOW)
                    )
                }
            }
            val launch = Intent(this, com.tanay.echo.settings.SettingsActivity::class.java)
            val tap = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE)
            val notif: Notification = NotificationCompat.Builder(this, channelId)
                .setSmallIcon(R.drawable.ic_mic)
                .setContentTitle(getString(R.string.floating_notif_title))
                .setContentText(getString(R.string.floating_notif_text))
                .setOngoing(true)
                .setContentIntent(tap)
                .build()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTIF_ID, notif)
            }
            true
        } catch (e: Exception) {
            false
        }
    }

    // ── Overlay bubble ───────────────────────────────────────────────────────────
    @SuppressLint("ClickableViewAccessibility") // bubble is a custom gesture target; cd_mic labels it
    private fun addBubble(): Boolean {
        bubble = LayoutInflater.from(this).inflate(R.layout.floating_bubble, null)
        idleIcon = bubble.findViewById(R.id.bubble_idle_icon)
        waveform = bubble.findViewById(R.id.bubble_wave)
        stopIcon = bubble.findViewById(R.id.bubble_stop)
        bubble.visibility = View.GONE // shown only when a keyboard is up

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        }
        lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        )
        // Anchor to the top-RIGHT: lp.x/lp.y are insets from the right/top, so the recording pill
        // grows leftward and stays on-screen.
        lp.gravity = Gravity.TOP or Gravity.END
        val dm = resources.displayMetrics
        val margin = (12 * dm.density).toInt()
        lp.x = if (settings.floatingX >= 0) settings.floatingX else margin
        lp.y = if (settings.floatingY >= 0) settings.floatingY else (96 * dm.density).toInt()

        bubble.setOnTouchListener { _, ev -> onTouch(ev) }
        // Whenever the bubble's size changes (idle squircle ↔ recording pill), keep it fully on-screen.
        bubble.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or2, ob ->
            if (r - l != or2 - ol || b - t != ob - ot) clampToScreenAndApply()
        }
        try {
            windowManager.addView(bubble, lp)
        } catch (e: Exception) {
            return false // overlay permission missing/revoked, or inflation failed — caller toasts
        }
        updateBubble(DictationPhase.IDLE)
        return true
    }

    private fun setBubbleVisible(visible: Boolean) {
        if (!::bubble.isInitialized) return
        if (!visible && mode != Mode.NONE) return // never yank the bubble mid-recording
        bubble.visibility = if (visible) View.VISIBLE else View.GONE
    }

    private fun onTouch(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                interp.down(ev.rawX, ev.rawY)
                dragStartLpX = lp.x; dragStartLpY = lp.y
                dragStartRawX = ev.rawX; dragStartRawY = ev.rawY
                movedDuringDrag = false
                main.postDelayed(holdRunnable, longPressMs)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (interp.move(ev.rawX, ev.rawY) is Gesture.Drag) {
                    main.removeCallbacks(holdRunnable)
                    movedDuringDrag = true
                    // END gravity: dragging right (rawX up) reduces the right-inset.
                    lp.x = (dragStartLpX - (ev.rawX - dragStartRawX)).toInt()
                    lp.y = (dragStartLpY + (ev.rawY - dragStartRawY)).toInt()
                    clampToScreen()
                    runCatching { windowManager.updateViewLayout(bubble, lp) }
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                main.removeCallbacks(holdRunnable)
                when (interp.up()) {
                    Gesture.Tap -> onTap()
                    Gesture.HoldEnd -> onHoldEnd()
                    else -> {}
                }
                if (movedDuringDrag) persistPosition()
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                main.removeCallbacks(holdRunnable)
                interp.up()
                return true
            }
        }
        return false
    }

    private fun clampToScreen() {
        val dm = resources.displayMetrics
        lp.x = lp.x.coerceIn(0, (dm.widthPixels - bubble.width).coerceAtLeast(0))
        lp.y = lp.y.coerceIn(0, (dm.heightPixels - bubble.height).coerceAtLeast(0))
    }

    private fun clampToScreenAndApply() {
        if (!::bubble.isInitialized) return
        val px = lp.x; val py = lp.y
        clampToScreen()
        if (lp.x != px || lp.y != py) runCatching { windowManager.updateViewLayout(bubble, lp) }
    }

    private fun persistPosition() {
        settings.floatingX = lp.x
        settings.floatingY = lp.y
    }

    // ── Recording control ──────────────────────────────────────────────────────────
    private fun onTap() {
        when (mode) {
            Mode.TAP -> stopRecording()
            Mode.HOLD -> {}
            Mode.NONE -> {
                if (transcribing) return
                if (!controller.isConfigured) { toast(getString(R.string.floating_configure)); return }
                silence.reset()
                controller.startCapture()
                mode = Mode.TAP
            }
        }
    }

    private fun onHoldStart() {
        if (mode != Mode.NONE || transcribing) return
        if (!controller.isConfigured) { toast(getString(R.string.floating_configure)); return }
        controller.startCapture()
        mode = Mode.HOLD
    }

    private fun onHoldEnd() {
        if (mode == Mode.HOLD) stopRecording()
    }

    private fun stopRecording() {
        val pkg = EchoAccessibilityService.instance?.focusedPackage() ?: ""
        mode = Mode.NONE
        transcribing = true
        controller.stopAndTranscribe(pkg)
    }

    private fun onLevel(level: Float) {
        waveform.setLevel(level)
        if (mode == Mode.TAP && silence.update(level, SystemClock.elapsedRealtime())) {
            stopRecording()
        }
    }

    private fun deliver(text: String) {
        val svc = EchoAccessibilityService.instance
        if (svc == null) {
            copyToClipboard(text)
            toast(getString(R.string.floating_no_a11y))
            return
        }
        if (!svc.pasteIntoFocusedField(text)) toast(getString(R.string.floating_copied))
    }

    private fun copyToClipboard(text: String) =
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
            .setPrimaryClip(ClipData.newPlainText("echo", text))

    private fun updateBubble(phase: DictationPhase, msg: String? = null) {
        when (phase) {
            // Idle squircle (lavender + purple waveform glyph). INSERTED collapses straight back —
            // the pasted text is the confirmation, Wispr-style.
            DictationPhase.IDLE, DictationPhase.EMPTY, DictationPhase.ERROR, DictationPhase.INSERTED -> {
                transcribing = false
                bubble.setBackgroundResource(R.drawable.bg_bubble_idle)
                idleIcon.visibility = View.VISIBLE
                waveform.visibility = View.GONE; waveform.stop()
                stopIcon.visibility = View.GONE
                if (phase == DictationPhase.ERROR) toast(msg ?: getString(R.string.floating_error))
            }
            // Purple pill with a white waveform; a white stop circle on the right in tap mode.
            DictationPhase.LISTENING -> {
                bubble.setBackgroundResource(R.drawable.bg_bubble_recording)
                idleIcon.visibility = View.GONE
                waveform.visibility = View.VISIBLE; waveform.start()
                stopIcon.visibility = if (mode == Mode.TAP) View.VISIBLE else View.GONE
            }
            DictationPhase.TRANSCRIBING -> {
                idleIcon.visibility = View.GONE
                waveform.visibility = View.VISIBLE; waveform.start()
                stopIcon.visibility = View.GONE
            }
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    companion object {
        private const val NOTIF_ID = 4711

        fun start(ctx: Context) {
            val i = Intent(ctx, FloatingButtonService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, FloatingButtonService::class.java))
    }
}
