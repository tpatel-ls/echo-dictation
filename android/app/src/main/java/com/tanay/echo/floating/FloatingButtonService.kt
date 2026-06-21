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
 * Tap = hands-free record (stops on a second tap or after a few seconds of silence); press-and-hold
 * = push-to-talk; drag = reposition. Runs as a microphone foreground service so it can capture while
 * another app is in front — started from Settings (a foreground context) per Android 14 rules.
 */
class FloatingButtonService : Service() {
    private lateinit var windowManager: WindowManager
    private lateinit var controller: DictationController
    private lateinit var settings: EchoSettings
    private val main = Handler(Looper.getMainLooper())

    private lateinit var bubble: View
    private lateinit var lp: WindowManager.LayoutParams
    private lateinit var micIcon: ImageView
    private lateinit var waveform: WaveformView
    private lateinit var checkIcon: ImageView

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
        controller.onPhase = { phase, _ -> main.post { updateBubble(phase) } }
        controller.onText = { text -> main.post { deliver(text) } }
        controller.onLevel = { level -> main.post { onLevel(level) } }
        startInForeground()
        if (!addBubble()) { stopSelf(); return }
        controller.triggerSync() // pull the latest dictionary so corrections are current
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        controller.dispose()
        if (::bubble.isInitialized) runCatching { windowManager.removeView(bubble) }
        super.onDestroy()
    }

    // ── Foreground service ─────────────────────────────────────────────────────────
    private fun startInForeground() {
        val channelId = "echo_floating"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(channelId) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        channelId,
                        getString(R.string.floating_channel),
                        NotificationManager.IMPORTANCE_LOW
                    )
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
    }

    // ── Overlay bubble ───────────────────────────────────────────────────────────
    @SuppressLint("ClickableViewAccessibility") // bubble is a custom gesture target; cd_mic labels it
    private fun addBubble(): Boolean {
        bubble = LayoutInflater.from(this).inflate(R.layout.floating_bubble, null)
        micIcon = bubble.findViewById(R.id.bubble_mic)
        waveform = bubble.findViewById(R.id.bubble_wave)
        checkIcon = bubble.findViewById(R.id.bubble_check)

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
        lp.gravity = Gravity.TOP or Gravity.START
        val dm = resources.displayMetrics
        val margin = (12 * dm.density).toInt()
        lp.x = if (settings.floatingX >= 0) settings.floatingX else dm.widthPixels
        lp.y = if (settings.floatingY >= 0) settings.floatingY else margin + (48 * dm.density).toInt()

        bubble.setOnTouchListener { _, ev -> onTouch(ev) }
        try {
            windowManager.addView(bubble, lp)
        } catch (e: Exception) {
            return false // overlay permission missing/revoked — give up cleanly
        }
        // Once measured, snap a default-positioned bubble flush to the top-right.
        bubble.post {
            if (settings.floatingX < 0) {
                lp.x = (dm.widthPixels - bubble.width - margin).coerceAtLeast(0)
                runCatching { windowManager.updateViewLayout(bubble, lp) }
            }
        }
        updateBubble(DictationPhase.IDLE)
        return true
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
                    lp.x = (dragStartLpX + (ev.rawX - dragStartRawX)).toInt()
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
        val pasted = EchoAccessibilityService.instance?.pasteIntoFocusedField(text) ?: run {
            (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                .setPrimaryClip(ClipData.newPlainText("echo", text))
            false
        }
        if (!pasted) toast(getString(R.string.floating_copied))
    }

    private fun updateBubble(phase: DictationPhase) {
        when (phase) {
            DictationPhase.IDLE, DictationPhase.EMPTY, DictationPhase.ERROR -> {
                transcribing = false
                bubble.setBackgroundResource(R.drawable.bg_bubble_idle)
                micIcon.visibility = View.VISIBLE
                waveform.visibility = View.GONE; waveform.stop()
                checkIcon.visibility = View.GONE
                if (phase == DictationPhase.ERROR) toast(getString(R.string.floating_error))
            }
            DictationPhase.LISTENING -> {
                bubble.setBackgroundResource(R.drawable.bg_bubble_recording)
                micIcon.visibility = View.GONE
                waveform.visibility = View.VISIBLE; waveform.start()
                checkIcon.visibility = if (mode == Mode.TAP) View.VISIBLE else View.GONE
            }
            DictationPhase.TRANSCRIBING -> {
                micIcon.visibility = View.GONE
                waveform.visibility = View.VISIBLE; waveform.start()
                checkIcon.visibility = View.GONE
            }
            DictationPhase.INSERTED -> {
                transcribing = false
                waveform.visibility = View.GONE; waveform.stop()
                micIcon.visibility = View.GONE
                checkIcon.visibility = View.VISIBLE
                main.postDelayed({ updateBubble(DictationPhase.IDLE) }, 900)
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
