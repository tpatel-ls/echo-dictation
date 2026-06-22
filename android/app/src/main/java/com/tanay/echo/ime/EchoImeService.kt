package com.tanay.echo.ime

import android.annotation.SuppressLint
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.inputmethodservice.InputMethodService
import android.os.Build
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.ImageButton
import android.widget.TextView
import androidx.core.content.ContextCompat
import com.tanay.echo.R
import com.tanay.echo.settings.SettingsActivity
import com.tanay.echo.transcription.PendingUndo

/**
 * The Echo dictation keyboard. A compact view with one big mic button (push-to-talk: hold →
 * speak → release inserts), a status pill mirroring the desktop DictationPhase, and a globe to
 * switch back to a normal keyboard. Transcribed text is committed into the focused field via
 * currentInputConnection.commitText(). The mic is pre-warmed when the keyboard opens for low
 * first-press latency.
 */
class EchoImeService : InputMethodService() {
    private lateinit var controller: DictationController
    private var pill: TextView? = null
    private var pendingUndo: PendingUndo? = null
    private val clearUndoRunnable = Runnable { clearUndo() }
    private val undoWindowMs = 5000L

    override fun onCreate() {
        super.onCreate()
        controller = DictationController(this)
        controller.onText = { text -> currentInputConnection?.commitText(text, 1) }
        controller.onReplace = { original, rewrite -> applyCommand(original, rewrite) }
        controller.onPhase = { phase, msg -> updatePill(phase, msg) }
    }

    @SuppressLint("ClickableViewAccessibility") // mic is press-and-hold; cd_mic gives the a11y label
    override fun onCreateInputView(): View {
        val view = layoutInflater.inflate(R.layout.keyboard_view, null)
        pill = view.findViewById(R.id.status_pill)
        val mic = view.findViewById<ImageButton>(R.id.mic_button)
        val globe = view.findViewById<ImageButton>(R.id.globe_button)

        mic.setOnTouchListener { v, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    if (!hasMicPermission()) {
                        promptForMic()
                    } else {
                        v.isPressed = true
                        clearUndoState() // a fresh capture supersedes any pending undo
                        controller.startCapture()
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    v.isPressed = false
                    v.performClick() // a11y: report the press-release as a click
                    if (hasMicPermission()) {
                        // Text selected → the speech is a command on it; otherwise normal dictation.
                        val sel = currentInputConnection?.getSelectedText(0)?.toString()
                        if (!sel.isNullOrBlank()) controller.stopAndCommand(sel)
                        else controller.stopAndTranscribe(focusedPackage())
                    }
                    true
                }
                MotionEvent.ACTION_CANCEL -> {
                    v.isPressed = false
                    controller.cancelCapture() // finger slid off / gesture cancelled — discard
                    true
                }
                else -> false
            }
        }
        globe.setOnClickListener { switchKeyboard() }
        return view
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        when {
            !controller.isConfigured -> updatePill(DictationPhase.ERROR, getString(R.string.ime_configure_first))
            !hasMicPermission() -> updatePill(DictationPhase.ERROR, getString(R.string.ime_grant_mic))
            else -> {
                controller.primeMic()
                controller.triggerSync() // pull the latest dictionary so the bias prompt is current
                updatePill(DictationPhase.IDLE, null)
            }
        }
    }

    override fun onFinishInputView(finishingInput: Boolean) {
        super.onFinishInputView(finishingInput)
        controller.releaseMic()
    }

    override fun onDestroy() {
        controller.dispose()
        super.onDestroy()
    }

    // ── Command Mode: replace the selection, then a tap-to-undo pill for a few seconds ───────────
    private fun applyCommand(original: String, rewrite: String) {
        val ic = currentInputConnection ?: return
        ic.commitText(rewrite, 1) // commitText replaces the still-active selection
        pendingUndo = PendingUndo(0, original, rewrite) // IME undo is cursor-based; start is unused
        showUndoPill()
    }

    private fun showUndoPill() {
        val p = pill ?: return
        p.text = getString(R.string.ime_tap_undo)
        p.setTextColor(ContextCompat.getColor(this, R.color.echo_accent))
        p.isClickable = true
        p.setOnClickListener { doUndo() }
        p.removeCallbacks(clearUndoRunnable)
        p.postDelayed(clearUndoRunnable, undoWindowMs)
    }

    /** Delete the rewrite and put the original back — only if the rewrite is still right before the
     *  cursor (so edits made during the window aren't clobbered). */
    private fun doUndo() {
        val u = pendingUndo
        val ic = currentInputConnection
        if (u != null && ic != null) {
            val before = ic.getTextBeforeCursor(u.rewrite.length, 0)?.toString()
            if (before == u.rewrite) {
                ic.deleteSurroundingText(u.rewrite.length, 0)
                ic.commitText(u.original, 1)
            }
        }
        clearUndo()
    }

    /** Drop the undo window without forcing the pill to idle (used when a new capture starts). */
    private fun clearUndoState() {
        pendingUndo = null
        pill?.let {
            it.removeCallbacks(clearUndoRunnable)
            it.isClickable = false
            it.setOnClickListener(null)
        }
    }

    private fun clearUndo() {
        clearUndoState()
        updatePill(DictationPhase.IDLE, null)
    }

    private fun updatePill(phase: DictationPhase, msg: String?) {
        val p = pill ?: return
        val (textRes, colorRes) = when (phase) {
            DictationPhase.IDLE -> R.string.ime_hold_to_speak to R.color.echo_muted
            DictationPhase.LISTENING -> R.string.ime_listening to R.color.echo_accent
            DictationPhase.TRANSCRIBING -> R.string.ime_transcribing to R.color.echo_accent
            DictationPhase.INSERTED -> R.string.ime_inserted to R.color.echo_ok
            DictationPhase.EMPTY -> R.string.ime_empty to R.color.echo_muted
            DictationPhase.ERROR -> R.string.ime_error to R.color.echo_danger
        }
        p.text = msg ?: getString(textRes)
        p.setTextColor(ContextCompat.getColor(this, colorRes))
        // Transient states settle back to the idle hint.
        if (phase == DictationPhase.INSERTED || phase == DictationPhase.EMPTY) {
            p.postDelayed({
                if (controller.isConfigured && hasMicPermission()) updatePill(DictationPhase.IDLE, null)
            }, 1200)
        }
    }

    private fun hasMicPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun promptForMic() {
        updatePill(DictationPhase.ERROR, getString(R.string.ime_grant_mic))
        startActivity(Intent(this, SettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun focusedPackage(): String = currentInputEditorInfo?.packageName ?: ""

    private fun switchKeyboard() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            switchToPreviousInputMethod()
        } else {
            getSystemService(InputMethodManager::class.java)?.showInputMethodPicker()
        }
    }
}
