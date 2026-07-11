# Echo

A Wispr-Flow-style push-to-talk dictation app for **Windows & macOS**. **Hold a key**
(Right Ctrl on Windows, Right ⌘ on macOS) anywhere to dictate; release to insert the
transcribed text at your cursor. A floating pill appears at the center-bottom of the
screen while you talk, and a dashboard keeps a searchable history of everything you've
dictated.

> **Phones (iOS / Android):** Echo is a desktop app, but it talks to a plain Whisper
> endpoint — so a voice keyboard on your phone can share the *same* self-hosted node. See
> [Dictating on your phone](#dictating-on-your-phone-ios--android).

Bring your own speech-to-text: Echo talks to **any OpenAI-compatible Whisper endpoint** —
a self-hosted node (faster-whisper-server, speaches, LocalAI…) or OpenAI itself. Optional
AI cleanup talks to **any Anthropic-compatible endpoint** — off the hot path, so inserts
stay instant.

```
   ╭───────────────────────────────╮
   │  ●  ▁▂▅▇▆▃▂▁▂▄  0:03           │   hold Right Ctrl → speak → release
   ╰───────────────────────────────╯
```

## Quick start

```bash
npm install
npm run dev
```

`npm run dev` launches the app (tray icon + overlay + dashboard). Then point Echo at your
endpoints — either:

- **Settings page** (dashboard): enter your Whisper base URL (e.g.
  `https://your-whisper-host/v1`), API key, and optionally a Claude-compatible base URL +
  key for cleanup, **or**
- **`secrets.local.json`** at the project root (gitignored — see
  `secrets.local.json.example`): keys *and endpoint URLs* are seeded from it, so a fresh
  install or packaged personal build works out of the box with zero clicks. Seeded URLs
  only fill empty settings — anything you set in the UI wins.

Either way, keys are stored **encrypted** via the OS credential store (Electron
`safeStorage`) — never in plain text, never in version control.

Hold **Right Ctrl**, speak, release — your words appear wherever your cursor is.

## How it works

| Action | Result |
|---|---|
| **Hold the trigger key** (Right Ctrl / Right ⌘) | Pill appears, mic records (other keys stay normal for shortcuts) |
| **Release** | Audio → Whisper → dictionary fixes → text pasted at your cursor → history |
| Tap it (<200ms) | Ignored (accidental tap) |
| Press another key while holding | Cancels — treated as a normal shortcut |

Open the dashboard from the tray icon to browse/search history, manage your dictionary,
see stats, change settings, or run diagnostics. Each transcript can be copied, re-inserted,
edited, deleted, **replayed** (if audio retention is on), or **cleaned up with AI** (fixes
punctuation, removes "um/uh", tidies formatting).

## Personal dictionary — never fix the same word twice

Whisper keeps hearing "Bryan" as "Brian"? Fix it once and it stays fixed:

- **Edit any transcript in History** (pencil icon). Echo diffs your edit, auto-learns
  word corrections ("Learned: Brian → Bryan", one-click Undo), and applies them to every
  future dictation.
- **Or add words manually** on the **Dictionary** page: the canonical spelling plus any
  "misheard as" aliases.

Under the hood it's two layers:

1. **Bias** — your dictionary words ride along in Whisper's `prompt` field, so the model
   prefers your spellings in the first place (names, jargon, product names).
2. **Guarantee** — a deterministic word-boundary replacement pass fixes known mishearings
   right after transcription, in microseconds, before pasting. AI cleanup also receives
   your glossary so it never "fixes" your words back.

Noise is filtered: punctuation-only edits, sentence-case changes, and full rewrites don't
pollute the dictionary; learning is skipped when a corrected-away word is itself one of
your dictionary words.

## Configuration

All in **Settings** (dashboard):

- **Whisper** — base URL of any OpenAI-compatible `/v1/audio/transcriptions` server +
  API key + model name.
- **AI cleanup** — base URL of any Anthropic-compatible `/v1/messages` endpoint + key +
  model. Modes: `off` (raw), `on-demand` (polish from history), or `auto` (clean every
  dictation before inserting). Default: **on-demand** — raw Whisper for speed.
- **Microphone** — `on-demand` (default) opens the mic only while dictating; `keep warm`
  pre-opens it so the first key-press has zero acquisition latency.
- **Keep audio recordings** — save each dictation's WAV so you can replay it from History
  (off by default). Deleting a transcript also deletes its audio file.
- **Trigger key** — Windows: Right Ctrl / Left Ctrl / Caps Lock / F8 · macOS: Right ⌘ /
  Right ⌥ / Left ⌘ / Caps Lock / F8. Plus **min hold**, **launch at login**, **overlay
  offset**.

## Architecture

```
src/
  shared/         types · WAV encoder · dictionary engine · formatting   (pure, unit-tested)
  main/           Electron main process
    hotkey/       machine.ts (pure PTT state machine) · listener.ts (uiohook)
    transcription/ whisper.ts · claude.ts
    store/        history.ts · dictionary.ts (sql.js) · settings.ts (safeStorage)
    insert/       paste.ts (clipboard save/restore) · window-focus.ts
    dictation.ts  the live dictation orchestrator
    learn.ts      transcript-edit → dictionary learning
    windows.ts · tray.ts · ipc.ts · diagnostics.ts · index.ts
  preload/        typed contextBridge → window.api
  renderer/
    overlay/      the pill (mic capture, waveform)
    dashboard/    history · dictionary · stats · settings · diagnostics (React + Tailwind)
```

- **Global hold-to-talk** uses a low-level keyboard hook (`uiohook-napi`) feeding a pure,
  unit-tested state machine.
- **The overlay never steals focus** (`focusable:false`, `showInactive`), and the target
  window is re-focused before pasting — so text always lands in the right place.
- **Insert** = set clipboard → re-focus target → Ctrl+V (`nut.js`) → restore your previous
  clipboard.
- **History + dictionary** live in `sql.js` (SQLite in WASM), persisted atomically at
  `%APPDATA%\echo\history.sqlite` (Windows) or `~/Library/Application Support/echo/history.sqlite`
  (macOS). No native compilation anywhere — `npm install` needs no build tools.

## Install & run always-on — Windows (autostart at boot)

```bash
npm install
npm run pack:win
```

Produces a self-contained app at `dist/win-unpacked/Echo.exe` (no installer, no admin
needed). Copy that folder somewhere stable (e.g. `%LOCALAPPDATA%\Programs\Echo`) and run
`Echo.exe` once — it registers itself to **launch at login** (hidden, straight to the tray)
and runs the hotkey in the background. Quit only via the tray. Toggle autostart in
Settings → Launch at login.

Building requires the .NET 8 SDK or newer. Echo cross-publishes three self-contained
`win-x64` helpers into `out/native`: an event-driven global key hook, a `SendInput`
copy/paste helper, and an optional `System.Speech` recognizer for independent accuracy
checks. The target PC does not need a separate .NET runtime. For native speech, install
the **English (United States)** speech pack in Windows Settings → Time & language → Speech.

If a `secrets.local.json` exists at the project root when you build, it's bundled into the
app's resources and seeds your keys on first run (see `electron-builder.yml` — remove that
block if you'd rather type keys into Settings).

### NSIS installer

```bash
npm run dist:win   # produces dist/Echo-0.1.0-setup.exe
```

electron-builder's `winCodeSign` toolchain contains macOS symlinks that can't unpack
without **symlink privilege**. If it fails with "A required privilege is not held", either
enable **Windows Developer Mode** (Settings → System → For developers) or run from an
**Administrator** terminal. `npm run pack` (above) avoids this entirely. The exe is
unsigned.

## Install & run always-on — macOS

macOS apps must be built **on a Mac** — electron-builder can't cross-compile them from
Windows. On any Mac (a spare Mac mini on your network is perfect):

```bash
git clone <your-repo-url> echo && cd echo
cp secrets.local.json.example secrets.local.json   # add your Whisper key + URL
npm install
npm run pack:mac     # → dist/mac*/Echo.app   (or `npm run dist:mac` for a .dmg)
```

Drag **Echo.app** to `/Applications` and open it. It runs as a **menu-bar app** (top-right
of the screen — no Dock icon), exactly like the Windows tray app.

**First launch — grant three permissions.** Echo triggers the prompts automatically; switch
each one on in **System Settings → Privacy & Security**, then **quit Echo from the menu bar
and reopen it** (macOS only honors a new key-tap permission on a fresh launch):

| Permission | Why Echo needs it |
|---|---|
| **Accessibility** | paste transcribed text into other apps |
| **Input Monitoring** | detect your hold-to-talk key anywhere |
| **Microphone** | hear you |

If the hotkey does nothing, it's almost always Input Monitoring — check the **Diagnostics**
page, which shows the live permission state.

**Gatekeeper:** the build is unsigned (no Apple Developer account required), so the first
time, **right-click Echo.app → Open** to get past “Apple cannot check it for malware.” Just
once.

**Trigger key:** macOS defaults to **Right ⌘** (Apple keyboards have no Right Ctrl). Change
it in **Settings → Trigger key** — Right ⌘, Right ⌥, Left ⌘, Caps Lock, or F8. Launch-at-
login and everything else behave just like Windows.

## Dictating on your phone (Android / iOS)

Echo itself is desktop-only, but its entire backend is just an **OpenAI-compatible Whisper
endpoint** — so a voice keyboard on your phone can use the very same self-hosted node:

1. **Reach your node from the phone.** Install **Tailscale**, sign into your tailnet, and
   `https://your-whisper-host/v1` becomes reachable on mobile data.
2. **Install a Whisper voice keyboard:**
   - **Android** — [whisper-to-input](https://github.com/j3soon/whisper-to-input) (open
     source). In its settings, set the endpoint to your node's `/v1` URL and paste your API
     key, then enable it under *System → Languages & input → On-screen keyboard*. Tap the
     mic on the keyboard to dictate into any app.
   - **iOS** — Apple sandboxes third-party keyboards tightly; the practical route is an
     **Apple Shortcut** that records audio and POSTs it to your node's
     `/v1/audio/transcriptions`, then pastes the result.
3. **Carry your spellings over.** On the **Dictionary** page, click **Export** and open the
   JSON — paste its `prompt` value into the keyboard's *prompt / initial-prompt* field (if
   it has one). Your phone now shares Echo's *bias* ("prefer Bryan, not Brian"). The
   deterministic find-and-replace layer stays desktop-only.

> **Echo ↔ Echo (Windows ↔ Mac):** your whole dictionary lives in `history.sqlite`. Copy it
> between machines — Windows `%APPDATA%\echo\` ↔ macOS `~/Library/Application Support/echo/`
> — and both installs share the same learned corrections instantly.

**Full parity (advanced).** To get the find-and-replace corrections on *every* device, front
your Whisper node with a tiny proxy that injects the bias prompt and applies the dictionary
server-side (it can reuse `src/shared/dictionary.ts` directly), then point every client at
the proxy instead of the node. Worth it only if you dictate from several devices daily.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Launch the app with hot reload |
| `npm test` | Run the unit suite (Vitest) |
| `npm run typecheck` | Type-check main + renderer |
| `npm run build` | Bundle main/preload/renderers |
| `npm run pack` | Build standalone `dist/win-unpacked/Echo.exe` (no admin) |
| `npm run dist` | Build the NSIS installer (needs Developer Mode / admin) |
| `npm run pack:mac` | Build `Echo.app` — **run on a Mac** |
| `npm run dist:mac` | Build a macOS `.dmg` — **run on a Mac** |
| `node scripts/test-whisper.mjs <key> <url>` | Probe a Whisper endpoint from the CLI |
| `node scripts/make-icons.mjs` | Regenerate app + tray icons |
| `npx electron scripts/smoke-electron.cjs` | Verify native modules load (no UI) |

## Troubleshooting

- **"Can't reach Whisper"** — check the base URL in Settings and that the server is up
  (self-hosted over a VPN/tailnet: confirm the tunnel is connected). Test it on the
  **Diagnostics** page.
- **Nothing pastes** — some apps block synthetic Ctrl+V. The text is still saved to
  history; use **Re-insert** or **Copy** from the dashboard.
- **Hotkey does nothing** — Windows requires the app to run with the same privilege level
  as the target window. If dictating into an elevated/admin app, run Echo as admin too.
  Check the **Global hotkey** diagnostic.
- **No transcript / "No speech detected"** — check the **Microphone** diagnostic and
  Windows mic permissions (Settings → Privacy → Microphone → Desktop apps).
- **Trigger key conflicts** — change it in Settings (Windows: Right/Left Ctrl, Caps Lock,
  F8 · macOS: Right ⌘, Right ⌥, Left ⌘, Caps Lock, F8).
- **macOS: hotkey or paste does nothing** — a privacy permission is missing. Grant
  **Accessibility**, **Input Monitoring**, and **Microphone** in System Settings → Privacy
  & Security, then quit Echo from the menu bar and reopen it. The Diagnostics page shows
  which one is missing.

## Security notes

- API keys are encrypted at rest via Electron `safeStorage` (OS credential store).
- `secrets.local.json` is **gitignored** — keys never enter version control.
- Audio goes only to the Whisper endpoint you configure; cleanup text only to the AI
  endpoint you configure. No audio is retained on disk by default.

## License

MIT
