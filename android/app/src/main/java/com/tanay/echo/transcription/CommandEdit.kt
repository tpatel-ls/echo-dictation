package com.tanay.echo.transcription

/**
 * Pure helpers for Command Mode's in-place edit + undo. Kept Android-free so the bounds/verification
 * logic — the part that must never corrupt the user's field — unit-tests without a device.
 */

/** What we remember after a command replace so a tap-to-undo can restore the exact original.
 *  [start] is where the rewrite begins in the field (used by the accessibility path; the IME path
 *  works off the cursor and ignores it). */
data class PendingUndo(val start: Int, val original: String, val rewrite: String)

/** A snapshot of a focused editable field: full [text] and the current selection range. A selection
 *  exists when selStart != selEnd; [selectedText] extracts it. */
data class EditableState(val text: String, val selStart: Int, val selEnd: Int)

/** The highlighted slice of [fullText], or null if the range is empty/invalid (nothing to act on). */
fun selectedText(fullText: String, selStart: Int, selEnd: Int): String? {
    if (selStart < 0 || selEnd > fullText.length || selStart >= selEnd) return null
    return fullText.substring(selStart, selEnd)
}

/** True iff [currentText] still holds [rewrite] starting at [start] — i.e. the field is unchanged
 *  since the replace, so restoring the original is safe. */
fun undoSliceMatches(currentText: String, start: Int, rewrite: String): Boolean {
    val end = start + rewrite.length
    if (start < 0 || end > currentText.length) return false
    return currentText.substring(start, end) == rewrite
}
