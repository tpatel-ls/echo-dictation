# Desktop Command-Mode trigger (Wispr-parity, desktop)

**Date:** 2026-06-22 · **Platform:** Desktop (Electron) · **Status:** implemented, pending live verification

## Goal

Bring Android's Command Mode to the desktop. Select text in any app, hold the push-to-talk key and
speak an instruction ("make this concise", "fix grammar", "translate to Spanish"), and Echo rewrites
the selection in place. The `command()` engine in `src/main/transcription/claude.ts` already exists
and is tested; this phase wires the **desktop trigger**.

## Decisions (locked with the user)

1. **Trigger — auto by selection (mirror Android).** On every dictation start we probe whether the
   focused app has a selection; if it does, the utterance is an *instruction* on that selection,
   otherwise it's normal dictation. No new gesture or key. (Rejected: Shift+PTT modifier; a second
   dedicated hotkey — both add a gesture the phone doesn't have.)
2. **Selection capture — Ctrl+C probe with a sentinel + poll.** Desktop has no API to read another
   app's selection (Android reads it via the IME/accessibility layer). We simulate Ctrl+C and read the
   clipboard, then restore it. A unique **sentinel** written before the copy distinguishes "nothing
   selected" (clipboard unchanged) from a real selection, killing false positives. We **poll** the
   clipboard until it changes (≈25 ms × up to ≈250 ms) instead of a single fixed delay, killing
   timing-based false negatives. The probe runs during the key-hold, overlapping speech, so it adds no
   perceived latency.
3. **Safety — three guards make always-on probing viable.**
   - **Terminal skip.** In a terminal (cmd / PowerShell / Windows Terminal / WSL / iTerm…) Ctrl+C with
     no selection is SIGINT — it would kill the user's running process. A pure `looksLikeTerminal(title)`
     check skips the probe for terminal windows. (This hazard does not exist on Android.)
   - **Claude-configured gate.** No Claude endpoint/key ⇒ command mode can't run ⇒ no probe at all
     (zero cost + zero clipboard thrash for users who don't use cleanup).
   - **Off-switch.** `commandModeEnabled` setting (default on) disables the probe entirely.
4. **Failure is non-destructive.** Empty instruction or any `command()` error ⇒ a status pill and
   **nothing is pasted** — the selection is never clobbered. (Unlike cleanup, command mode does *not*
   fall back to pasting the raw text.) Mirrors Android's `stopAndCommand`.
5. **Undo — native.** The rewrite is a single Ctrl+V paste, so the target app's own Ctrl+Z undoes it.
   (Rejected for v1: a custom re-select/repaste undo like Android's — desktop can't reliably re-select
   arbitrary text across apps.)
6. **History — commands are not recorded.** Like Android, a command is an edit, not a capture.

## Architecture

- **`src/main/insert/selection.ts`** (new, pure, tested): `captureSelection(deps)` — save clipboard →
  write sentinel → `sendCopy()` → poll clipboard until it differs from the sentinel (or times out) →
  **always restore** the saved clipboard → return the captured selection, or `null` (no selection).
  Deps (`readClipboard`, `writeClipboard`, `sendCopy`, `delay`, timings) are injected, mirroring
  `paste.ts`, so it unit-tests with no OS.
- **`src/main/insert/terminal.ts`** (new, pure, tested): `looksLikeTerminal(title)` — substring match
  on terminal app/window keywords, same spirit as `app-style.ts`'s `registerForTitle`.
- **`src/main/insert/paste-deps.ts`**: add `realSelectionDeps()` returning real `SelectionDeps`
  (Electron clipboard + nut.js Ctrl/⌘+C), mirroring `realPasteDeps`.
- **`src/main/dictation.ts`**:
  - `onStart()` — after snapshotting the foreground window, if `commandModeEnabled` && Claude
    configured && `!looksLikeTerminal(title)`, start `captureSelection(...)` and stash the **promise**
    (`this.selectionProbe`) so there's no race with a fast key-release.
  - `handleAudio()` — `await this.selectionProbe`. If it yielded a non-empty selection → **command
    path**: `instruction = heard.trim()`; on empty → empty pill, no paste; else
    `command(selection, instruction, settings, claudeApiKey, undefined, dict.map(e=>e.word))` →
    `pasteText(rewrite, …)`; on any throw → error pill, no paste. Otherwise the existing dictation path
    runs unchanged.
- **`src/shared/types.ts`**: add `commandModeEnabled: boolean` to `Settings` + `DEFAULT_SETTINGS`
  (default `true`).
- **`src/renderer/dashboard/pages/Settings.tsx`**: a "Voice commands" toggle in the "AI cleanup
  (Claude)" section.

## What does not change

The hotkey listener, `HotkeyMachine`, and their tests are untouched — the trigger is the same PTT key.

## Testing

- **Pure / TDD:** `tests/selection.test.ts` (sentinel-unchanged → null; poll-until-change → selection;
  empty copy → null; clipboard always restored on every path) and `tests/terminal.test.ts`
  (`looksLikeTerminal` positive/negative cases).
- **On-device (`npm run dev`, before commit):**
  - Select a sentence in Notepad / VS Code / a browser field → "make this more formal" → it rewrites.
  - Dictate normally with nothing selected → plain dictation, unchanged.
  - **Terminal:** with nothing selected, dictate into Windows Terminal / PowerShell → the running
    process is **not** interrupted (probe skipped).
  - Clipboard contents are intact after both a command and a normal dictation.
  - `command()` proxy down or empty instruction → selection is preserved, nothing pasted.
  - Native Ctrl+Z undoes the rewrite.

## Deferred / non-goals

- Custom re-select/repaste undo (rely on native Ctrl+Z).
- Recording commands to history.
- Snippets desktop authoring UI (separate, sync already covers it).
- Streaming / real-time cleanup (documented non-goal — batch Whisper + batch Claude).
