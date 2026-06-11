# Murmur Dictation Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Build order is
> dependency-ordered; each task produces self-contained, committable changes. TDD the pure
> logic; native/GUI verified via the in-app Diagnostics panel + manual checklist.

**Goal:** A Windows push-to-talk dictation app — hold Right Ctrl anywhere to dictate via a
self-hosted Whisper node, insert text at the cursor, with a floating pill and a transcripts
dashboard.

**Architecture:** Electron multi-process. Main (Node) owns the global keyboard hook, tray,
HTTP clients, SQLite, and paste injection. Two renderers: a non-focus-stealing overlay pill
(mic capture + waveform) and a React/Tailwind dashboard.

**Tech Stack:** Electron, TypeScript, electron-vite, React, Tailwind, `uiohook-napi`,
`@nut-tree-fork/nut-js`, `better-sqlite3`, `vitest`, `electron-builder`.

---

## File structure

```
voiceapp/
  package.json, electron.vite.config.ts, electron-builder.yml
  tsconfig.json, tsconfig.node.json, tsconfig.web.json
  tailwind.config.js, postcss.config.js
  src/
    shared/
      types.ts              # IPC channel names, Transcript, Settings, payload types
      wav.ts                # pure PCM(Float32)->WAV(16kHz mono 16-bit) encoder
      format.ts             # word count, time-saved, relative time helpers
    main/
      index.ts              # app lifecycle, wires everything
      windows.ts            # createOverlay(), createDashboard()
      tray.ts               # system tray + menu
      ipc.ts                # registers IPC handlers (renderer <-> main)
      hotkey/
        machine.ts          # pure push-to-talk state machine
        listener.ts         # uiohook-napi wiring -> machine -> events
      transcription/
        whisper.ts          # POST audio -> text
        claude.ts           # POST text -> cleaned text
      store/
        settings.ts         # settings + safeStorage secrets (userData/settings.json)
        history.ts          # better-sqlite3 history + FTS5
      insert/
        paste.ts            # save clipboard -> set text -> refocus -> Ctrl+V -> restore
        window-focus.ts     # snapshot + refocus foreground window (nut.js)
    preload/
      index.ts              # typed contextBridge api
    renderer/
      overlay/
        index.html, main.tsx, Overlay.tsx
        capture.ts          # mic -> AudioWorklet -> Float32 frames -> WAV
        pcm-worklet.ts      # AudioWorklet processor (raw PCM tap)
        Waveform.tsx        # canvas level meter
      dashboard/
        index.html, main.tsx, App.tsx
        pages/{History,Stats,Settings,Diagnostics}.tsx
        components/{Sidebar,TranscriptRow,SearchBar,StatCard,Toggle,Field}.tsx
        lib/api.ts          # window.api typed wrappers
        index.css           # tailwind entry
  tests/
    wav.test.ts, machine.test.ts, paste-clipboard.test.ts,
    whisper.test.ts, claude.test.ts, history.test.ts, format.test.ts
```

---

## Task 1: Scaffold + tooling

- [ ] `package.json` with deps + scripts (`dev`, `build`, `typecheck`, `test`, `dist`).
- [ ] electron-vite config with three entries (main, preload, overlay+dashboard renderers).
- [ ] tsconfig (node + web), Tailwind + PostCSS, `.gitignore`.
- [ ] `npm install`; confirm it resolves. Commit.

## Task 2: Shared types + pure helpers (TDD)

- [ ] `tests/format.test.ts` → `src/shared/format.ts` (`wordCount`, `estimatedSecondsSaved`,
      `relativeTime`). Run, pass, commit.
- [ ] `src/shared/types.ts`: `Transcript`, `Settings`, `DEFAULT_SETTINGS` (pre-filled
      endpoints), `IpcChannels` const, dictation event/state unions.

## Task 3: WAV encoder (TDD)

- [ ] `tests/wav.test.ts`: encoding N Float32 samples at 48kHz → valid WAV header (RIFF/WAVE/
      fmt/data), 16kHz mono 16-bit, correct byte length, clamps out-of-range samples.
- [ ] `src/shared/wav.ts`: `encodeWav(frames: Float32Array[], inputRate): ArrayBuffer` with
      linear-resample to 16k, mono, Int16 PCM, standard 44-byte header. Pass, commit.

## Task 4: Hotkey state machine (TDD)

- [ ] `tests/machine.test.ts`: press→release under threshold = no-dictation; press→hold past
      threshold→release = start+stop events; other-key during hold = cancel; release without
      press = ignored; double press idempotent.
- [ ] `src/main/hotkey/machine.ts`: pure `HotkeyMachine` emitting `start|stop|cancel`,
      `minHoldMs` configurable, time injected (no real clock). Pass, commit.

## Task 5: Whisper + Claude clients (TDD, mocked fetch)

- [ ] `tests/whisper.test.ts`: builds multipart with file+model, posts to `<base>/audio/
      transcriptions`, parses `{text}`, throws typed error on non-200/network.
- [ ] `src/main/transcription/whisper.ts`: `transcribe(wav, settings): Promise<string>`.
- [ ] `tests/claude.test.ts`: posts Anthropic `/v1/messages` shape, parses text content,
      returns input unchanged on failure (never throws on hot path use).
- [ ] `src/main/transcription/claude.ts`: `cleanup(text, settings): Promise<string>`. Commit.

## Task 6: Settings + history store (TDD history)

- [ ] `src/main/store/settings.ts`: load/save JSON in userData; secrets via `safeStorage`
      (`encryptString`/`decryptString`), fallback plaintext if unavailable; merge DEFAULTS.
- [ ] `tests/history.test.ts` (in-memory better-sqlite3): insert returns row w/ id; list
      newest-first w/ paging; FTS search matches text; stats aggregate; delete; updateCleaned.
- [ ] `src/main/store/history.ts`: schema + FTS5 triggers + methods. Pass, commit.

## Task 7: Window focus + paste (TDD clipboard logic)

- [ ] `src/main/insert/window-focus.ts`: `snapshot()`/`refocus(handle)` via nut.js
      `getActiveWindow()`; tolerate failures (return null, no throw).
- [ ] `tests/paste-clipboard.test.ts`: `pasteText` saves prior clipboard, sets new text,
      restores prior after paste; injects clipboard + keytap fns (no real OS).
- [ ] `src/main/insert/paste.ts`: `pasteText(text, deps)` orchestrates save→set→refocus→
      Ctrl+V→restore with timing. Real deps wired in main. Pass, commit.

## Task 8: Main process — windows, tray, IPC, wiring

- [ ] `src/main/windows.ts`: `createOverlay()` (transparent, non-focusable, screen-saver
      alwaysOnTop, center-bottom of primary display, showInactive), `createDashboard()`.
- [ ] `src/main/tray.ts`: tray icon + menu (Open dashboard, AI-cleanup toggle, Quit).
- [ ] `src/preload/index.ts`: typed `window.api` (invoke/handlers, event subscriptions).
- [ ] `src/main/ipc.ts`: handlers — `dictation:audio` (transcribe→save→paste→reply),
      history CRUD, settings get/set, diagnostics tests, polishWithClaude.
- [ ] `src/main/hotkey/listener.ts`: uiohook → machine → IPC to overlay (`show`/`hide`) +
      foreground snapshot.
- [ ] `src/main/index.ts`: app ready → load settings → init history → create windows →
      start hotkey listener → tray → autostart per settings. Commit.

## Task 9: Overlay renderer

- [ ] `pcm-worklet.ts` + `capture.ts`: getUserMedia → AudioWorklet → Float32 frames →
      `encodeWav` on stop; pre-warm option.
- [ ] `Overlay.tsx` + `Waveform.tsx`: subscribe to dictation state; render pill states;
      canvas waveform from live levels; auto-resize/position. Commit.

## Task 10: Dashboard renderer

- [ ] Shell: `App.tsx`, `Sidebar`, routing between pages, Tailwind theme.
- [ ] History page: list (paged), `SearchBar` (FTS), `TranscriptRow` actions (copy,
      re-insert, Claude polish, delete), empty state.
- [ ] Stats page: `StatCard`s from history stats.
- [ ] Settings page: `Field`/`Toggle` bound to settings; test buttons.
- [ ] Diagnostics page: run mic/hotkey/whisper/claude/paste checks. Commit.

## Task 11: Packaging + docs + verify

- [ ] `electron-builder.yml` (NSIS, appId, native module unpack), build icons.
- [ ] `README.md`: run/dev/build, hotkey, troubleshooting (Tailscale, build tools, mic perm).
- [ ] `npm run typecheck` + `npm test` green; `npm run build` (electron-vite) succeeds.
- [ ] Manual smoke checklist documented. Final commit.

---

## Self-review notes

- Spec coverage: hotkey (T4/T8), overlay non-focus-steal (T8/T9), Whisper hot path
  (T5/T8), Claude off-path (T5/T10), paste+restore+refocus (T7/T8), history+FTS (T6/T10),
  stats (T2/T10), settings+secrets (T6/T10), diagnostics (T10), packaging (T11). ✓
- Types defined in T2 (`Transcript`, `Settings`, `IpcChannels`) are referenced consistently
  by stores, IPC, preload, and renderers.
- No placeholders: each task names exact files + behavior; code written at execution time
  against these interfaces.
