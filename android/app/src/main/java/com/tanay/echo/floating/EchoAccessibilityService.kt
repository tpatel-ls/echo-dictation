package com.tanay.echo.floating

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * The OS-sanctioned bridge for inserting dictated text into another app's focused field. The
 * floating button isn't a keyboard, so it can't use an InputConnection — instead this service
 * pastes at the cursor of whatever editable field currently has input focus, preserving the text
 * already there. It exposes a process-wide [instance] the FloatingButtonService calls into.
 */
class EchoAccessibilityService : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onUnbind(intent: Intent?): Boolean {
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    // We pull focus on demand rather than react to events.
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    /** Package of the app currently in front — stored with the transcript like desktop app_context. */
    fun focusedPackage(): String = rootInActiveWindow?.packageName?.toString() ?: ""

    /**
     * Paste [text] at the cursor of the focused editable field. Saves and restores the clipboard so
     * the user's copied content survives a successful paste. Returns true only if a focused field
     * accepted the paste; on failure the transcript is left on the clipboard for a manual paste.
     */
    fun pasteIntoFocusedField(text: String): Boolean {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val node = findFocusedEditable()
        if (node == null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("echo", text))
            return false
        }
        val saved = clipboard.primaryClip
        clipboard.setPrimaryClip(ClipData.newPlainText("echo", text))
        val pasted = node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
        node.recycle()
        if (pasted) {
            // Restore the prior clipboard once the paste has been consumed.
            main.postDelayed({
                try {
                    clipboard.setPrimaryClip(saved ?: ClipData.newPlainText("", ""))
                } catch (_: Exception) { /* clipboard owner gone — ignore */ }
            }, 400)
        }
        return pasted
    }

    private fun findFocusedEditable(): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused != null && focused.isEditable) return focused
        focused?.recycle()
        return null
    }

    companion object {
        @Volatile
        var instance: EchoAccessibilityService? = null
            private set

        val isEnabled: Boolean get() = instance != null
    }
}
