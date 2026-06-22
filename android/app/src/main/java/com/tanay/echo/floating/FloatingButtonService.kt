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
import android.graphics.Point
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
import com.tanay.echo.transcription.PendingUndo
import com.tanay.echo.transcription.selectedText
import com.tanay.echo.transcription.undoSliceMatches

/**
 * A system-wide floating mic button. Hosts the bubble in a non-focusable WindowManager overlay (so
 * the app underneath keeps its text-field focus) and reuses the IME's DictationController, routing
 * transcribed text through the accessibility service to paste into whatever field is focused.
 *
 * Visible only while a soft keyboard is up. By default it docks just above the keyboard on the right
 * (Wispr-style) from the keyboard's reported top edge — but that accessibility read is unreliable, so
 * once you drag the bubble it pins to that exact screen spot (both axes persisted) and never derives
 * its position from the keyboard again. Drag = reposition (any direction); tap = hands-free record
 * (stops on a 2nd tap or after silence); press-and-hold = push-to-talk. Runs as a microphone
 * foreground service so it can capture while another app is in front; started from Settings (a
 * foreground context) per Android 14 rules.
 */
class FloatingButtonService : Service() {
    private lateinit var windowManager: WindowManager
    private lateinit var controller: DictationController
    private lateinit var settings: EchoSettings
    private val main = Handler(Looper.getMainLooper())

    private lateinit var bubble: View        // root: holds the soft glow + breathing room for the halo/shadow
    private lateinit var pill: View          // the visible button: idle squircle ↔ recording pill
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

    // Command Mode: after a replace, a tap-to-undo is armed for a few seconds. commandStart is the
    // selection's start index, captured at stop, so undo knows where to restore.
    private var pendingUndo: PendingUndo? = null
    private var commandStart = 0

    private var dragStartLpX = 0
    private var dragStartLpY = 0
    private var dragStartRawX = 0f
    private var dragStartRawY = 0f
    private var movedDuringDrag = false
    private var draggingNow = false

    private val holdRunnable = Runnable {
        if (interp.holdTimerFired() is Gesture.HoldStart) onHoldStart()
    }

    private val clearUndoRunnable = Runnable { clearUndo() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        settings = EchoSettings(this)
        controller = DictationController(this)
        controller.onPhase = { phase, msg -> main.post { updateBubble(phase, msg) } }
        controller.onText = { text -> main.post { deliver(text) } }
        controller.onReplace = { original, rewrite -> main.post { applyCommand(original, rewrite) } }
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
        pill = bubble.findViewById(R.id.bubble_pill)
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
                // IN_SCREEN: lay out in full-display coordinates so the Gravity.BOTTOM inset is
                // measured from the physical screen bottom — matching maximumWindowMetrics and the
                // keyboard's getBoundsInScreen, so the above-keyboard math is nav-bar-independent.
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        )
        // Bottom-RIGHT anchor: lp.x/lp.y are insets from the right/bottom. resolvePosition() sets the
        // real spot on each show — a saved drag position if any, else the default dock above the
        // keyboard. Seed from saved values so a pinned bubble appears correctly before the first resolve.
        lp.gravity = Gravity.BOTTOM or Gravity.END
        val dm = resources.displayMetrics
        lp.x = if (settings.floatingX >= 0) settings.floatingX else (DEFAULT_RIGHT_DP * dm.density).toInt()
        lp.y = if (settings.floatingY >= 0) settings.floatingY else (DEFAULT_BOTTOM_DP * dm.density).toInt()

        bubble.setOnTouchListener { _, ev -> onTouch(ev) }
        // Idle squircle ↔ recording pill changes width; keep it fully on-screen when it does.
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
        if (visible) {
            // Place it now, then again once the keyboard's open animation settles (the IME window's
            // reported top can still be moving on the first event). A no-op once the bubble is pinned.
            main.post { resolvePosition() }
            main.postDelayed({ resolvePosition() }, 140)
        }
    }

    /**
     * Place the bubble. If the user has dragged it before (a saved Y exists), restore that exact
     * screen spot and leave it — this is what stops the bubble drifting onto the keys. Otherwise use
     * the default dock: top-right, just above the keyboard (see [BubbleDock.defaultDockInset], which
     * guards against the unreliable keyboard-top read).
     */
    private fun resolvePosition() {
        if (!::bubble.isInitialized || bubble.visibility != View.VISIBLE) return
        if (draggingNow) return // don't fight an in-progress drag (e.g. the 140ms settle re-place)
        val dm = resources.displayMetrics
        lp.x = if (settings.floatingX >= 0) settings.floatingX else (DEFAULT_RIGHT_DP * dm.density).toInt()
        lp.y = if (settings.floatingY >= 0) {
            settings.floatingY // pinned: exactly where the user left it, no keyboard math involved
        } else {
            BubbleDock.defaultDockInset(
                screenHeight = screenHeightPx(),
                keyboardTop = EchoAccessibilityService.instance?.keyboardTopY() ?: -1,
                gapPx = (ABOVE_KB_GAP_DP * dm.density).toInt(),
                glowPadPx = (GLOW_PAD_DP * dm.density).toInt(),
                fallbackFraction = FALLBACK_KB_FRACTION,
            )
        }
        clampToScreen()
        runCatching { windowManager.updateViewLayout(bubble, lp) }
    }

    private fun onTouch(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                interp.down(ev.rawX, ev.rawY)
                dragStartLpX = lp.x
                dragStartLpY = lp.y
                dragStartRawX = ev.rawX
                dragStartRawY = ev.rawY
                movedDuringDrag = false
                main.postDelayed(holdRunnable, longPressMs)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (interp.move(ev.rawX, ev.rawY) is Gesture.Drag) {
                    main.removeCallbacks(holdRunnable)
                    movedDuringDrag = true
                    draggingNow = true
                    // Free reposition in both axes. BOTTOM|END gravity: dragging right (rawX up)
                    // reduces the right-inset; dragging down (rawY up) reduces the bottom-inset.
                    lp.x = (dragStartLpX - (ev.rawX - dragStartRawX)).toInt()
                    lp.y = (dragStartLpY - (ev.rawY - dragStartRawY)).toInt()
                    clampToScreen()
                    runCatching { windowManager.updateViewLayout(bubble, lp) }
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                main.removeCallbacks(holdRunnable)
                draggingNow = false
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
                draggingNow = false
                interp.up()
                return true
            }
        }
        return false
    }

    private fun clampToScreen() {
        lp.x = lp.x.coerceIn(0, (screenWidthPx() - bubble.width).coerceAtLeast(0))
        lp.y = lp.y.coerceIn(0, (screenHeightPx() - bubble.height).coerceAtLeast(0))
    }

    private fun clampToScreenAndApply() {
        if (!::bubble.isInitialized) return
        val px = lp.x; val py = lp.y
        clampToScreen()
        if (lp.x != px || lp.y != py) runCatching { windowManager.updateViewLayout(bubble, lp) }
    }

    private fun persistPosition() {
        // Both axes: resolvePosition() restores this exact spot on every later show, so the bubble
        // stays where the user dropped it instead of re-deriving a position from the keyboard.
        settings.floatingX = lp.x
        settings.floatingY = lp.y
    }

    private fun screenWidthPx(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            windowManager.maximumWindowMetrics.bounds.width()
        } else {
            val p = Point(); @Suppress("DEPRECATION") windowManager.defaultDisplay.getRealSize(p); p.x
        }

    private fun screenHeightPx(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            windowManager.maximumWindowMetrics.bounds.height()
        } else {
            val p = Point(); @Suppress("DEPRECATION") windowManager.defaultDisplay.getRealSize(p); p.y
        }

    // ── Recording control ──────────────────────────────────────────────────────────
    private fun onTap() {
        if (pendingUndo != null) { doUndo(); return } // a tap during the undo window means "undo"
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
        clearUndoState() // starting a fresh capture supersedes any pending undo
        controller.startCapture()
        mode = Mode.HOLD
    }

    private fun onHoldEnd() {
        if (mode == Mode.HOLD) stopRecording()
    }

    private fun stopRecording() {
        val svc = EchoAccessibilityService.instance
        val pkg = svc?.focusedPackage() ?: ""
        // If text is selected, the speech is a command on it (Wispr-style); otherwise it's dictation.
        val editable = svc?.readEditable()
        val selected = editable?.let { selectedText(it.text, it.selStart, it.selEnd) }
        mode = Mode.NONE
        transcribing = true
        if (selected != null) {
            commandStart = editable.selStart
            controller.stopAndCommand(selected)
        } else {
            controller.stopAndTranscribe(pkg)
        }
    }

    // ── Command Mode: replace the selection, then a tap-to-undo for a few seconds ────────────────
    private fun applyCommand(original: String, rewrite: String) {
        transcribing = false
        mode = Mode.NONE
        val svc = EchoAccessibilityService.instance
        if (svc == null) {
            copyToClipboard(rewrite)
            toast(getString(R.string.floating_no_a11y))
            updateBubble(DictationPhase.IDLE)
            return
        }
        svc.pasteIntoFocusedField(rewrite) // the selection is still active — paste replaces it
        pendingUndo = PendingUndo(commandStart, original, rewrite)
        showUndo()
    }

    /** Show the bubble as a tap-to-undo for UNDO_WINDOW_MS, then auto-collapse. */
    private fun showUndo() {
        bubble.visibility = View.VISIBLE
        bubble.setBgKeepingPadding(0)
        pill.setBgKeepingPadding(R.drawable.bg_bubble_idle)
        idleIcon.setImageResource(R.drawable.ic_undo)
        idleIcon.visibility = View.VISIBLE
        waveform.visibility = View.GONE; waveform.stop()
        stopIcon.visibility = View.GONE
        main.removeCallbacks(clearUndoRunnable)
        main.postDelayed(clearUndoRunnable, UNDO_WINDOW_MS)
    }

    /** Re-select the rewrite and paste the original back — but only if the field is unchanged, so we
     *  never clobber edits made during the window (and only if the field honors set-selection). */
    private fun doUndo() {
        val u = pendingUndo ?: return
        val svc = EchoAccessibilityService.instance
        if (svc != null) {
            val cur = svc.readEditable()
            if (cur != null && undoSliceMatches(cur.text, u.start, u.rewrite) &&
                svc.setSelection(u.start, u.start + u.rewrite.length)) {
                svc.pasteIntoFocusedField(u.original)
            }
        }
        clearUndo()
    }

    /** Cancel the undo window and restore the idle glyph, without forcing visibility (used when a new
     *  capture supersedes it). */
    private fun clearUndoState() {
        main.removeCallbacks(clearUndoRunnable)
        pendingUndo = null
        idleIcon.setImageResource(R.drawable.ic_waveform)
    }

    private fun clearUndo() {
        clearUndoState()
        updateBubble(DictationPhase.IDLE) // resets state + re-checks keyboard visibility
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
            // Accessibility is the only way to paste from outside a keyboard. Without it we can't
            // insert at all — leave the text on the clipboard and say so once. This is a one-time
            // setup state (the Settings master switch requires a11y), not a per-dictation message.
            copyToClipboard(text)
            toast(getString(R.string.floating_no_a11y))
            return
        }
        // Paste silently. ACTION_PASTE's Boolean result is unreliable — Samsung Messages / WhatsApp
        // return false even when the paste visibly succeeds — so we must NOT surface it. A
        // per-dictation "copied" toast off that false-negative is the noise the user asked us to
        // remove. On a genuine failure pasteIntoFocusedField leaves the text on the clipboard.
        svc.pasteIntoFocusedField(text)
    }

    private fun copyToClipboard(text: String) =
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
            .setPrimaryClip(ClipData.newPlainText("echo", text))

    /**
     * Swap a background without the new drawable's (zero) intrinsic padding wiping the view's own
     * padding. The default dock math depends on the root's 16dp ring being stable, and some OEM
     * View internals reset padding on background change — read-then-restore makes it deterministic.
     */
    private fun View.setBgKeepingPadding(resId: Int) {
        val l = paddingLeft; val t = paddingTop; val r = paddingRight; val b = paddingBottom
        setBackgroundResource(resId)
        setPadding(l, t, r, b)
    }

    private fun updateBubble(phase: DictationPhase, msg: String? = null) {
        when (phase) {
            // Idle squircle (lavender + purple waveform glyph), no glow. INSERTED collapses straight
            // back — the pasted text is the confirmation, Wispr-style.
            DictationPhase.IDLE, DictationPhase.EMPTY, DictationPhase.ERROR, DictationPhase.INSERTED -> {
                transcribing = false
                mode = Mode.NONE
                bubble.setBgKeepingPadding(0) // halo off
                pill.setBgKeepingPadding(R.drawable.bg_bubble_idle)
                idleIcon.visibility = View.VISIBLE
                waveform.visibility = View.GONE; waveform.stop()
                stopIcon.visibility = View.GONE
                if (phase == DictationPhase.ERROR) toast(msg ?: getString(R.string.floating_error))
                // Recording finished — resync visibility so the bubble hides immediately if the
                // keyboard (or app) closed while we were capturing, when the mid-recording guard
                // blocked the hide and the a11y service already deduped to "closed".
                setBubbleVisible(EchoAccessibilityService.instance?.isKeyboardOpen() ?: false)
            }
            // Purple pill with a soft violet halo + white waveform; white stop circle in tap mode.
            DictationPhase.LISTENING -> {
                bubble.setBgKeepingPadding(R.drawable.bg_bubble_glow)
                pill.setBgKeepingPadding(R.drawable.bg_bubble_recording)
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
        private const val GLOW_PAD_DP = 16f      // must match floating_bubble.xml root padding
        private const val ABOVE_KB_GAP_DP = 12f  // visible gap between the pill and the keyboard top
        private const val DEFAULT_RIGHT_DP = 4f  // right inset of the window (pill sits ~GLOW_PAD in)
        private const val DEFAULT_BOTTOM_DP = 120f // provisional bottom inset before the first resolve
        private const val FALLBACK_KB_FRACTION = 0.45f // assumed keyboard height when its top reads bogus
        private const val UNDO_WINDOW_MS = 5000L // how long the tap-to-undo stays after a command

        fun start(ctx: Context) {
            val i = Intent(ctx, FloatingButtonService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, FloatingButtonService::class.java))
    }
}
