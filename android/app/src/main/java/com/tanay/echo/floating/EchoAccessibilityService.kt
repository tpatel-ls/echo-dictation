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
import android.view.accessibility.AccessibilityWindowInfo

/**
 * The OS-sanctioned bridge for inserting dictated text into another app's focused field. The
 * floating button isn't a keyboard, so it can't use an InputConnection — instead this service
 * pastes at the cursor of whatever editable field currently has input focus, preserving the text
 * already there. It exposes a process-wide [instance] the FloatingButtonService calls into.
 *
 * It also reports when a soft keyboard is on screen ([visibilityListener]) so the floating bubble
 * only appears while the user is actually typing, not all the time.
 */
class EchoAccessibilityService : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    private var lastKeyboardOpen = false

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

    // Drive bubble visibility off keyboard show/hide. Deduped so we only notify on a real change.
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val open = keyboardShowing()
        if (open != lastKeyboardOpen) {
            lastKeyboardOpen = open
            visibilityListener?.invoke(open)
        }
    }

    override fun onInterrupt() {}

    /** True while a soft-input (keyboard) window is on screen. Also syncs the dedupe baseline so the
     *  next show/hide event fires correctly even if the keyboard was already up at startup. */
    fun isKeyboardOpen(): Boolean {
        val open = keyboardShowing()
        lastKeyboardOpen = open
        return open
    }

    private fun keyboardShowing(): Boolean = try {
        windows?.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD } ?: false
    } catch (e: Exception) {
        false
    }

    /** Package of the app currently in front — stored with the transcript like desktop app_context. */
    @Suppress("DEPRECATION") // recycle() is a no-op on API 30+ but still frees the node on 26–29
    fun focusedPackage(): String {
        val root = rootInActiveWindow ?: return ""
        return try {
            root.packageName?.toString() ?: ""
        } finally {
            root.recycle()
        }
    }

    /**
     * Paste [text] at the cursor of the focused editable field. Saves and restores the clipboard on a
     * successful paste so the user's copied content survives. Returns true only if a focused field
     * accepted the paste; on any failure the transcript is left on the clipboard for a manual paste
     * (the deliberate fallback — see FloatingButtonService.deliver). Never throws.
     */
    @Suppress("DEPRECATION")
    fun pasteIntoFocusedField(text: String): Boolean {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        var root: AccessibilityNodeInfo? = null
        var node: AccessibilityNodeInfo? = null
        try {
            root = rootInActiveWindow
            val focused = root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            node = if (focused?.isEditable == true) {
                focused
            } else {
                focused?.recycle()
                null
            }
            if (node == null) {
                // No editable field focused — leave the transcript on the clipboard for a manual paste.
                clipboard.setPrimaryClip(ClipData.newPlainText("echo", text))
                return false
            }
            val saved = clipboard.primaryClip
            clipboard.setPrimaryClip(ClipData.newPlainText("echo", text))
            val pasted = node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            if (pasted) {
                main.postDelayed({
                    try {
                        clipboard.setPrimaryClip(saved ?: ClipData.newPlainText("", ""))
                    } catch (_: Exception) { /* clipboard owner gone — ignore */ }
                }, 400)
            }
            return pasted
        } catch (e: Exception) {
            runCatching { clipboard.setPrimaryClip(ClipData.newPlainText("echo", text)) }
            return false
        } finally {
            node?.recycle()
            root?.recycle()
        }
    }

    companion object {
        @Volatile
        var instance: EchoAccessibilityService? = null
            private set

        /** Set by FloatingButtonService: invoked with true/false as a soft keyboard shows/hides. */
        @Volatile
        var visibilityListener: ((Boolean) -> Unit)? = null

        val isEnabled: Boolean get() = instance != null
    }
}
