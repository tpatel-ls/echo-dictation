# Echo — System-wide floating dictation button, Wispr-style overlay, cross-device dictionary

- **Date:** 2026-06-21
- **Status:** Design approved; implementation pending
- **Supersedes/extends:** `2026-06-20-android-keyboard-and-sync-design.md` (the IME + sync foundation this builds on)

## 1. Background & motivation

Echo dictates on Android only through the Echo IME — a dedicated keyboard the user must switch
to. Switching keyboards is inconvenient. The user wants **one always-available mic button that
floats over every app**, so they keep their Samsung Keyboard for editing and tap/hold a single
button to dictate anywhere.

Two adjacent problems surfaced:
- The user dictionary (e.g. "Brian" → "Bryan") works on desktop but **not on the phone**.
- The desktop recording overlay looks heavy; the user wants a **minimal, elegant Wispr-Flow**
  aesthetic.

## 2. Goals

1. A **system-wide floating mic button** on Android that inserts transcribed text into whatever
   field is focused, without switching keyboards.
   - **Tap** = hands-free record; stop on the ✓ **or** after a few seconds of silence.
   - **Press-and-hold** = push-to-talk.
2. **Auto-paste** the transcript into the focused field of any app (via an AccessibilityService).
3. **Cross-device dictionary + history sync actually working** (desktop ↔ server ↔ phone), so a
   correction made on one device applies on all of them.
4. A **minimal, elegant desktop overlay** (violet pill, white waveform, no red dot, no timer).

## 3. Non-goals (YAGNI)

- Intercepting the power button. The OS blocks third-party apps from a background double-press
  trigger; on Samsung it launches an app, which loses the text-field focus we need.
- A full QWERTY layout inside Echo / replacing Samsung Keyboard.
- New transcription behaviour. The pipeline (Whisper → dictionary → optional Claude cleanup) is
  reused unchanged.

## 4. Part A — Floating dictation button (Android)

### 4.1 Decisions (from brainstorming)
- **Text insertion:** auto-paste via AccessibilityService (chosen over copy-only and keyboard-only).
- **Tap-mode stop:** tick **OR** silence (silence default ~3 s, adjustable).
- **Position:** top-right, draggable.

### 4.2 Why this works (key constraints)
- The overlay window uses `TYPE_APPLICATION_OVERLAY` with **`FLAG_NOT_FOCUSABLE | FLAG_NOT_TOUCH_MODAL`**.
  The bubble receives its own touches, but the underlying app keeps input focus and cursor —
  which is what lets a paste land in the field you are already typing in.
- Cross-app text insertion is only sanctioned through an **AccessibilityService**. It snapshots
  the clipboard, sets it to the transcript, performs `ACTION_PASTE` on the focused node (insert at
  cursor, preserving surrounding text), then restores the previous clipboard shortly after.

### 4.3 Components
| Component | Kind | Role |
|---|---|---|
| `EchoAccessibilityService` | new `AccessibilityService` | `pasteIntoFocusedField(text)`; static `instance`; clipboard save/paste/restore; fallback = leave on clipboard + report false. |
| `FloatingButtonService` | new foreground `Service` | Owns the `WindowManager` bubble + a reused `DictationController`. Routes `onText` → accessibility paste, `onPhase` → bubble UI. FGS type microphone + low-priority notification. |
| `WaveformView` + bubble layouts/drawables | new `View` + res | Lavender mic (idle) → violet pill with animated white bars + ✓ (recording), per reference image 6. States mirror `DictationPhase`. |
| `SilenceDetector` | new pure logic (TDD) | `update(amplitude, nowMs)`; fires stop after `silenceMs` continuously below `threshold`; resets on speech. |
| `GestureInterpreter` | new pure logic (TDD) | DOWN/UP/MOVE/CANCEL + timing → Tap / HoldStart / HoldEnd / Drag; distinguishes tap from long-press. |
| `DictationController`, `MicRecorder`, Whisper, dictionary, sync | **unchanged** | Reused as-is. `MicRecorder` gains a live-amplitude callback only if it doesn't already expose one (needed by waveform + silence detector). |

### 4.4 Interaction
- **Tap** → start hands-free recording; bubble becomes the waveform pill with a **✓**; stops on ✓
  tap **or** after silence → paste.
- **Press-and-hold** → push-to-talk; waveform pill while held; release → paste.
- **Drag** → reposition the bubble (persist last position).

### 4.5 Permissions / onboarding (SettingsActivity)
New status cards, each with a one-tap **Enable**:
1. Draw over other apps (`SYSTEM_ALERT_WINDOW`, via `Settings.canDrawOverlays()` + manage intent).
2. Accessibility — Echo Dictation (guide to Settings → Accessibility; **Android-13 sideload note**:
   App info → ⋮ → *Allow restricted settings* first).
3. Notifications (Android 13+; for the foreground-service pill).
4. Master **"Floating mic button" on/off** toggle, persisted to `EchoSettings` (`floatingEnabled`).

Manifest gains `SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`,
`POST_NOTIFICATIONS`, and registers `FloatingButtonService` (exported=false, fgs type microphone)
and `EchoAccessibilityService` (`BIND_ACCESSIBILITY_SERVICE`, exported=false, accessibilityService
intent-filter + meta-data).

The Echo keyboard stays as a no-extra-permission fallback — untouched.

### 4.6 Testing
- TDD on the JVM: `SilenceDetector`, `GestureInterpreter`, clipboard save/restore helper (pure
  parts), any payload/text mapping.
- Framework pieces (overlay window, a11y paste, live gestures) cannot be unit-tested or driven from
  the dev machine — built to spec, compiled, shipped in the APK; **final confirmation on-device**.

## 5. Part B — Desktop overlay restyle (Wispr aesthetic)

Files: `src/renderer/overlay/overlay.css`, `Overlay.tsx`, `Waveform.tsx`. Logic and window
mechanics (`src/main/windows.ts`, `src/main/dictation.ts`) unchanged — still click-through,
always-on-top, bottom-centre.

- Remove `.ov-rec` (red blinking dot) and `.ov-time` (timer) from the listening view.
- Pill: **violet** (e.g. gradient `#7C3AED` → `#6D28D9`) with a soft outer glow, replacing 86%
  white; height ~50 → ~40 px; tighter padding/radius.
- Waveform: **white/translucent bars on violet** (live); calm = dimmer white. (Currently indigo on
  white.)
- Inserted: subtle white ✓, quick fade.
- Verify: `npm run build` + `npm run typecheck`; screenshot via the `ECHO_USER_DATA` E2E recipe;
  existing overlay tests stay green.

## 6. Part C — Cross-device dictionary + history sync (the real fix)

### 6.1 Root cause
Sync was never wired end-to-end:
- Desktop sync no-ops unless `settings.syncBaseUrl` **and** `secrets.syncToken` are set
  (`src/main/index.ts:70`).
- The server refuses to start without `SYNC_TOKEN` (`src/server/index.ts:17`).
- Android `isSyncConfigured` requires non-empty `syncBaseUrl` **and** `syncToken`; the gitignored
  `android/defaults.local.properties` has an **empty** `syncToken`.

No shared token was ever set, so nothing syncs and the phone's dictionary stays empty → "Brian"
is never corrected to "Bryan". **The dictionary code is correct on both sides** (verified): tables,
`applyDictionary()` immediately after Whisper, and a synced `dictionary` collection each side.
Last-write-wins with per-collection pull cursors already covers the dictionary identically to
transcripts — this is a configuration gap, not a logic bug.

### 6.2 Fix
1. Generate a strong shared `SYNC_TOKEN`.
2. **Run the sync service on the GB10** (`whisper.tail7e0fa0.ts.net:8787` — the always-on host the
   phone and desktop already reach for Whisper): `SYNC_TOKEN=… npm run sync-server` (port 8787).
   Document persistence (the user's host); smoke-test health / push / pull / 401-on-bad-token.
3. **Desktop:** set `syncBaseUrl = http://whisper.tail7e0fa0.ts.net:8787` and `syncToken`
   (seed via the gitignored `secrets.local.json`, which currently has neither; verify how
   `SettingsStore` sources `syncToken` — set via the secrets seed and/or Settings UI accordingly).
4. **Android:** fill `syncToken=<token>` in the gitignored `android/defaults.local.properties` so
   the APK ships pre-wired.
5. **Verify** "Brian → Bryan" round-trips desktop → server → phone, and a phone-made correction
   reaches the desktop.

Generalize the stray "Mac Mini" comment in `src/server/index.ts` to "tailnet host (GB10)". All
secrets remain gitignored; nothing personal is committed.

## 7. Rollout / build order
**C** (turn on sync — quick) → **B** (desktop restyle — quick visual win) → **A** (floating button —
the big build) → one final APK containing the sync token *and* the floating button. Each task is
verified before the next begins (per the user's request).

## 8. Risks & honest limits
- Android overlay/accessibility can't be verified from this machine; final check is on-device.
- AccessibilityService is a sensitive permission; sideloaded apps need "Allow restricted settings"
  on Android 13+.
- Clipboard paste depends on the focused app supporting `ACTION_PASTE`; fallback = the transcript is
  left on the clipboard with a "paste manually" hint.
- Running the sync server persistently on the GB10 is the user's infrastructure; the design provides
  the command and a smoke test, not a managed deployment.
