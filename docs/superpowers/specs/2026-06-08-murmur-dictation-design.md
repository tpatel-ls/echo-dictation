# Murmur — Push-to-Talk Dictation for Windows (Design)

**Date:** 2026-06-08
**Status:** Approved
**Working name:** Murmur (rename anytime)

## Goal

A Wispr-Flow-style dictation app for Windows. Hold **Right Ctrl** anywhere in Windows to
dictate; release to insert the transcribed text at the cursor. A center-bottom floating
"pill" shows live listening state. A native dashboard stores and searches past transcripts.

Transcription uses the user's self-hosted Whisper node on the tailnet. Optional AI cleanup
uses the user's zero-cost Claude proxy on a Mac Mini — **off the hot path** (on-demand /
optional auto), never blocking the fast insert.

## Endpoints (user-configured in Settings)

- **Whisper (transcription):** any OpenAI-compatible `/v1/audio/transcriptions` server
  (e.g. a self-hosted node on the tailnet) · model `whisper-1` · key stored encrypted
- **Claude (AI cleanup):** any Anthropic-compatible `/v1/messages` proxy · key stored
  encrypted

## Decisions

| Decision | Choice |
|---|---|
| Stack | Electron + TypeScript, React + Tailwind renderers, electron-vite, electron-builder |
| Trigger | Hold **Right Ctrl** → dictate; release → insert. Left Ctrl untouched. |
| Insert | Paste via clipboard (set → Ctrl+V → restore original clipboard) |
| Transcription | Raw Whisper on hot path (fast). Claude = on-demand polish + optional auto, never blocks. |
| History | `better-sqlite3` at `userData/history.db`, FTS5 search |
| Secrets | Electron `safeStorage` (OS-keychain encrypted) |

## Process architecture

- **Main** (Node): app lifecycle, system tray, global keyboard hook (`uiohook-napi`),
  window management, Whisper + Claude HTTP clients, SQLite history, settings, clipboard +
  paste injection (`@nut-tree-fork/nut-js`), autostart. All secrets + network here.
- **Overlay renderer**: frameless, transparent, always-on-top, **non-focus-stealing** pill at
  center-bottom. Captures mic (Web Audio `AudioWorklet`), draws live waveform, shows states.
- **Dashboard renderer**: history list + search, stats, settings, diagnostics.

### Non-focus-stealing overlay (critical)

The overlay must never take focus, or the paste lands in the pill instead of the target app.
Created with `focusable:false`, `transparent:true`, `frame:false`, `skipTaskbar:true`,
`alwaysOnTop` at `screen-saver` level, shown via `showInactive()`, `setIgnoreMouseEvents(true)`.
Main snapshots the foreground window on key-down and re-focuses it before pasting.

## Dictation loop (hot path)

```
RightCtrl ↓ (uiohook, global)
  → snapshot foreground window → showInactive() pill → overlay starts mic → live waveform
RightCtrl ↑
  → overlay finalizes 16kHz mono WAV → IPC ArrayBuffer → main
  → pill "Transcribing…"
  → main POST multipart WAV → Whisper /v1/audio/transcriptions
  → save transcript row → save clipboard → set clipboard=text
  → refocus original window → nut.js Ctrl+V → restore clipboard after ~120ms
  → pill "✓ inserted" → fade
```

Guard rails: holds < ~200ms ignored (accidental tap); another key pressed while Right Ctrl
held → cancel dictation (user meant a shortcut); empty/silent audio → "No speech detected",
no paste.

## Data model (SQLite)

`transcripts(id INTEGER PK, created_at INTEGER, raw_text TEXT, cleaned_text TEXT NULL,
duration_ms INTEGER, word_count INTEGER, latency_ms INTEGER, app_context TEXT,
model TEXT, status TEXT('ok'|'failed'|'empty'), audio_path TEXT NULL)`
Plus FTS5 virtual table mirroring `raw_text`/`cleaned_text` for search.
Audio not retained by default (setting to keep).

## UI

**Overlay pill** (center-bottom, ~24px off bottom): states = Listening (waveform + timer),
Transcribing (spinner), Inserted (✓ + first words, fade), Error (red message).

**Dashboard**: sidebar (History / Stats / Settings / Diagnostics).
- History: rows with time, app context, word count, latency, text; actions = copy,
  re-insert, ✨ Clean up with Claude, delete. Search box (FTS5).
- Stats: words dictated, est. time saved, streak, today's count.
- Settings: hotkey, min-hold ms, AI-cleanup mode (off/auto/on-demand), Whisper + Claude
  endpoints/keys/models (pre-filled), launch-at-login, audio retention, mic mode.
- Diagnostics: one-click tests for mic, hotkey capture, Whisper, Claude, paste.

## AI cleanup (off hot path)

On-demand button (and optional auto mode) → main POSTs raw text to Claude proxy
(`/v1/messages`, Anthropic-compatible) with a "fix punctuation, remove filler words, keep
meaning verbatim, return only the cleaned text" prompt → stores `cleaned_text`. Proxy down →
keep raw, badge it.

## Error handling

Whisper unreachable → pill "Can't reach Whisper (Tailscale up?)", row saved `failed`, no
paste. Mic denied → tray + dashboard banner. Empty audio → "No speech detected". Paste target
lost → refocus snapshot mitigates; worst case pastes at current cursor.

## Testing

TDD the pure logic: hotkey state machine (down/hold/release/cancel/min-threshold), PCM→WAV
encoder, clipboard save/restore, Whisper + Claude clients (mocked fetch), history store
(in-memory). Native I/O (mic, hook, paste) covered by in-app Diagnostics + manual smoke
checklist (can't run GUI/input synthesis in CI).

## Packaging

`electron-builder` → Windows NSIS installer; launch-at-login via `app.setLoginItemSettings`.
`npm run dev` for development. Native modules: `uiohook-napi` and `nut-js` are N-API
(no rebuild); `better-sqlite3` rebuilt for Electron via `@electron/rebuild` postinstall.
