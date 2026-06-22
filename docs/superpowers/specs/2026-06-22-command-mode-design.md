# Command Mode (Phase 2 of the Wispr-Flow parity track)

**Date:** 2026-06-22 · **Platform:** Android (IME + floating mic) · **Status:** implemented

## Goal

Select text in any field, speak an instruction ("make this concise", "fix grammar", "bulletize",
"translate to Spanish"), and Echo rewrites the selection in place — Wispr Flow's Command Mode.

## Decisions (locked with the user)

1. **Trigger — auto by selection.** If text is selected when you stop dictating, the speech is an
   *instruction* on that selection; with nothing selected, it's normal dictation. No new UI.
   (Rejected: explicit gesture/button; spoken keyword prefix.)
2. **Safety — replace + quick undo.** The rewrite replaces the selection immediately; a tap-to-undo
   stays for ~5s and restores the exact original. (Rejected: silent replace; preview-before-replace.)
3. **Scope — both surfaces** (floating mic + IME), since the orchestration is shared.

## Architecture

- **`transcription/CommandEdit.kt`** (new, pure, tested): `selectedText(full, start, end)`,
  `undoSliceMatches(current, start, rewrite)` (undo only if the field is unchanged), `PendingUndo`,
  `EditableState`.
- **`transcription/Claude.kt`**: `buildCommandSystem(glossary)` + `buildCommandUser(instruction,
  text)` (pure, tested); `ClaudeClient.command(...)`. Extracted a shared private `complete()` so
  cleanup and command share one round-trip. On empty/failed response → returns the original (no-op).
- **`ime/DictationController.kt`**: `stopAndCommand(selectedText)` — transcribe the instruction →
  `claude.command` → `onReplace(original, rewrite)`. Requires Claude; **on any failure nothing is
  replaced**, so a bad/aborted command never destroys the selection.
- **`floating/EchoAccessibilityService.kt`**: `readEditable()` (text + selection) and `setSelection`.
  The initial replace reuses the existing `pasteIntoFocusedField` (paste replaces the live selection);
  only undo needs `setSelection`.
- **Hosts** read the selection at stop and route command-vs-dictation, perform the replace, and own
  the undo affordance:
  - **Floating mic**: bubble shows an undo glyph (`ic_undo`) for 5s; tap = undo.
  - **IME**: status pill becomes "↶ Tap to undo" for 5s; tap = undo.

## Undo

Remember `(start, original, rewrite)` on replace. Undo re-selects `[start, start+rewrite.length]`,
**verifies the slice still equals the rewrite** (`undoSliceMatches` / `getTextBeforeCursor`), then
restores the original. IME undo is solid (`getTextBeforeCursor` + `deleteSurroundingText` +
`commitText`). **Floating/accessibility undo is best-effort** — it depends on the field honoring
`ACTION_SET_SELECTION`; if it refuses, undo is skipped rather than risking corruption (accepted).

## Testing

- **Pure/TDD:** `CommandEditTest` (selectedText range/empty/out-of-bounds; undoSliceMatches
  match/edited/out-of-bounds); `ClaudeTest` (+command system/user prompt building). Full suite green.
- **On-device:** select a sentence in WhatsApp → "make this more formal" → it rewrites; tap undo →
  original returns. Repeat in Gmail and a notes app, and via the Echo keyboard.

## Deferred / follow-ups

- Reading the browser address bar for site-aware command context; persisting commands to history.
- Desktop Command Mode. Later Wispr-parity phases: Snippets, Multilingual UX.
