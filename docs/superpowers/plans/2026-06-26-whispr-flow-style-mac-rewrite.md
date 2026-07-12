# Whispr Flow-Style Mac Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polished Whispr Flow-style macOS dictation app for all local users with bottom-bar dictation, history, dictionary learning, context cleanup, retry, diagnostics, seeded proxy credentials, and all-user autostart.

**Architecture:** Replace the lightweight prototype with an Electron/Vite/React app. Reuse the reference Echo product modules for history, dictionary, learning, sync, cleanup, and dashboard, then swap the macOS hotkey/paste backend to the Swift helpers already proven on this machine. The overlay is a focus-safe, bottom-center glass bar with live mic capture and waveform states.

**Tech Stack:** Electron, electron-vite, React, Tailwind, TypeScript, Vitest, sql.js, macOS Swift helper binaries, launchd LaunchAgent.

## Global Constraints

- Keep `secrets.local.json` local and bundled for this personal build; never print secret values in chat.
- Default trigger on this Mac is left or right Option, exposed as Option in settings.
- App installs to `/Applications/Echo.app`.
- All-user login start uses `/Library/LaunchAgents/com.tanay.echo.plist`.
- macOS privacy permissions remain user-approved: Microphone, Input Monitoring, Accessibility.
- Bottom bar should be Flow-inspired, not a verbatim proprietary clone.
- Tests must cover pure dictionary, learning, hotkey, paste, and settings behavior.

---

### Task 1: Replace App Shell With Full Product Base

**Files:**
- Replace: `package.json`, `electron.vite.config.ts`, `tsconfig*.json`, `src/**`, `tests/**`, `build/**`, `electron-builder.yml`
- Preserve: `secrets.local.json`, `native/EchoKeyHelper.swift`, `native/EchoPasteHelper.swift`, `launchd/com.tanay.echo.plist`, `scripts/install-mac-all-users.mjs`

**Interfaces:**
- Produces `npm run build`, `npm test`, `npm run dist:mac`.

- [ ] Copy the reference Echo product source into the workspace while preserving local secrets and Mac installer files.
- [ ] Install dependencies.
- [ ] Run tests to capture baseline failures.

### Task 2: Mac Native Hotkey and Paste Backends

**Files:**
- Create/Modify: `src/main/hotkey/listener.ts`
- Create/Modify: `src/main/insert/paste-deps.ts`
- Create/Modify: `scripts/build-native.mjs`
- Test: `tests/machine.test.ts`, `tests/paste-clipboard.test.ts`

**Interfaces:**
- `HotkeyListener.start()` uses `EchoKeyHelper` instead of `uiohook-napi` on macOS.
- `realPasteDeps()` uses `EchoPasteHelper` instead of `nut-js` on macOS.

- [ ] Keep the pure hotkey state machine and tests.
- [ ] Route helper JSON events to `HotkeyMachine`.
- [ ] Preserve clipboard before paste and restore after paste.

### Task 3: Settings, Seed, and Option Trigger Defaults

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/trigger.ts`, `src/main/store/settings.ts`, `src/renderer/dashboard/pages/Settings.tsx`
- Test: `tests/seed.test.ts`, `tests/platform.test.ts`

**Interfaces:**
- Default mac trigger is `EitherOption`.
- Settings UI shows left/right/either Option choices.

- [ ] Add `EitherOption`, `LeftOption`, `RightOption` trigger keys.
- [ ] Seed Whisper, Claude/OpenAI proxy, sync URL, and sync token from `secrets.local.json`.
- [ ] Mask secrets in UI while preserving saved values on save.

### Task 4: Flow-Style Bottom Bar

**Files:**
- Modify: `src/renderer/overlay/Overlay.tsx`, `src/renderer/overlay/Waveform.tsx`, `src/renderer/overlay/overlay.css`, `src/main/windows.ts`

**Interfaces:**
- Overlay states: `listening`, `transcribing`, `inserted`, `empty`, `error`.
- Capture sends audio to main on release.

- [ ] Build bottom-center glass capsule, waveform, timer, status, and compact controls.
- [ ] Keep overlay click-through and non-focusable.
- [ ] Respect reduced motion.

### Task 5: Dictation, Cleanup, Context Fixes, and History

**Files:**
- Modify: `src/main/dictation.ts`, `src/main/transcription/whisper.ts`, `src/main/transcription/claude.ts`, `src/shared/dictionary.ts`, `src/main/learn.ts`, `src/main/store/history.ts`
- Test: `tests/dictionary.test.ts`, `tests/learn.test.ts`, `tests/history.test.ts`, `tests/claude.test.ts`, `tests/whisper.test.ts`

**Interfaces:**
- Dictation flow: audio → Whisper prompt bias → deterministic dictionary fixes → optional cleanup → paste → history.
- Edit flow: transcript edit → learned dictionary correction → future prompt bias and replacement.

- [ ] Include app/window context in cleanup prompt.
- [ ] Add cleanup modes: off, on-demand, auto.
- [ ] Keep failed audio for retry when possible.

### Task 6: Build, Install, and Verify

**Files:**
- Modify: `electron-builder.yml`, `scripts/install-mac-all-users.mjs`, `launchd/com.tanay.echo.plist`

**Interfaces:**
- Installed app runs under launchd.
- Artifacts: `dist/Echo-0.1.0-arm64.dmg`, `dist/Echo-0.1.0-arm64-mac.zip`, `dist/mac-arm64/Echo.app`.

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `npm run dist:mac`.
- [ ] Install `/Applications/Echo.app`.
- [ ] Load `/Library/LaunchAgents/com.tanay.echo.plist`.
- [ ] Smoke test installed app with isolated `ECHO_USER_DATA`.
