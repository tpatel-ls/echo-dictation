# Echo

Echo is an accuracy-first English dictation app for macOS, Windows x64, and Android. Hold a
global key on desktop or use the Android voice keyboard/floating mic, speak naturally, and Echo
inserts a faithful transcript at the cursor. It includes a bottom recording bar, searchable
history, learned dictionary corrections, snippets, context-aware cleanup, and cross-device sync.

The app talks to your OpenAI-compatible `/audio/transcriptions` endpoint. Optional cleanup and
transcript adjudication use your configured AI proxy. Audio and text are not sent anywhere else.

## What is included

| Platform | Trigger and insertion | Background startup |
| --- | --- | --- |
| macOS | Hold either Option key by default, release to paste | `/Library/LaunchAgents/com.tanay.echo.plist` for every local user |
| Windows x64 | Hold Right Ctrl by default, release to paste | Machine-wide installer registers hidden startup for every user |
| Android 8+ | Echo voice keyboard or floating mic | Android foreground service when the floating mic is enabled |

Desktop feedback is event-driven and targets less than 50 ms from trigger to visible recording
state on a warm process. Final transcription includes audio upload and model inference, so it
cannot honestly be guaranteed below 50 ms. Maximum accuracy runs several recognition hypotheses
in parallel and favors correctness over final-response latency.

## Accuracy pipeline

1. Capture speech as mono 16 kHz PCM WAV with speech-oriented audio constraints.
2. Send `language=en`, a dictionary bias prompt, and deterministic temperature `0` to Whisper.
3. In Maximum mode, compare five concurrent remote hypotheses. macOS and Windows can also include
   their native English speech recognizer.
4. Reject wrong-script output, Icelandic `eth`/`thorn` drift, decoder repetition, empty results,
   and assistant-style replies.
5. Ground disagreements through the configured Responses API. A reconstruction must be supported
   by recognizer candidates; Echo never asks the model to answer the dictated content.
6. Apply deterministic dictionary aliases, spoken formatting, snippets, and optional cleanup.
7. If confidence remains low, insert nothing and keep retained audio available for retry.

The three desktop modes are:

- **Maximum** (default): five concurrent remote hypotheses plus native recognition when available.
- **Balanced**: one fast decode, with recovery only when its quality is not clean.
- **Fast**: one deterministic decode, still protected by the rejection gate.

## Desktop development

Requirements: Node.js 20+; Swift/Xcode command-line tools on macOS; .NET 8 SDK for Windows helper
builds.

```bash
npm install
npm test
npm run typecheck
npm run dev
```

Open Settings and enter:

- Whisper base URL, API key, and model.
- AI proxy base URL, key, cleanup model, and adjudicator model.
- Optional sync URL and token.

For a preconfigured personal build, create the gitignored `secrets.local.json` from
`secrets.local.json.example`. It seeds empty settings for each user. The seed is optional; source
builds without it still package normally and can be configured in the UI.

## Install on this Mac for all users

```bash
npm install
npm run dist:mac
sudo npm run install:mac:all-users
```

This copies the locally signed app to `/Applications/Echo.app`, installs the machine-wide
LaunchAgent, starts Echo hidden for the console user, and keeps it event-driven in the background.
Every local user gets separate history, settings, and credentials under their own
`~/Library/Application Support/echo` directory.

Each macOS user must grant these once in **System Settings > Privacy & Security**:

| Permission | Used for |
| --- | --- |
| Accessibility | Paste text into the focused app |
| Input Monitoring | Detect Option/Caps Lock/F8 globally |
| Microphone | Capture speech |

Quit and reopen Echo after changing Input Monitoring or Accessibility. The Diagnostics page shows
the live state. The default trigger is **Left or Right Option**; Settings can select either side,
Command, Caps Lock, or F8.

Local artifact outputs:

- `dist/Echo-0.1.0-arm64.dmg`
- `dist/Echo-0.1.0-arm64-mac.zip`

## Install on Windows for all users

Build from macOS or Windows:

```bash
npm install
npm run dist:win
```

Run `dist/Echo-0.1.0-setup.exe` and accept the UAC prompt. The NSIS installer is pinned to x64,
installs machine-wide, creates desktop/Start Menu shortcuts, and registers
`Echo.exe --hidden` under the 64-bit HKLM Run key so every user starts Echo at sign-in. Each user
still has separate settings/history and can disable **Launch at login**; a disabled profile exits
immediately when invoked by the machine startup entry.

The installer contains self-contained x64 helpers for the global keyboard hook, SendInput paste,
and `System.Speech`; the target PC does not need .NET. For the independent native recognizer,
install **English (United States)** under Windows **Time & language > Speech**.

The Windows installer is currently unsigned. Windows may show a SmartScreen warning on first run.
The local artifact is `dist/Echo-0.1.0-setup.exe`.

## Install on Android

The native Kotlin app lives in `android/` and supports both an Echo IME and a floating microphone.
It shares the English quality gate, dictionary, history, snippets, context cleanup, and sync
service used by desktop.

```bash
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Install `android/app/build/outputs/apk/debug/app-debug.apk`, open Echo, enter the same endpoints,
grant microphone access, and enable either **Echo Voice Keyboard** or the floating mic permissions.
See [Android build and install](docs/android-build-and-install.md) for exact device steps.

## History and learning

The dashboard provides transcript search, copy/reinsert, editing, deletion, retained-audio replay,
AI cleanup, and retry transcription. Editing a transcript learns word-level corrections such as
`Brian -> Bryan`; future requests bias Whisper toward the canonical term and a deterministic pass
fixes known aliases before insertion. The dictionary and transcript history can sync across
desktop and Android through the included self-hosted service.

Run the sync service:

```bash
SYNC_TOKEN='a-long-random-token' npm run sync-server
```

Deployment details are in [the sync server guide](src/server/README.md).

## Useful scripts

| Command | Result |
| --- | --- |
| `npm test` | Desktop Vitest suite |
| `npm run typecheck` | Main/preload and renderer TypeScript checks |
| `npm run build` | macOS native helpers plus Electron production bundle |
| `npm run build:win` | Windows x64 helpers plus Electron production bundle |
| `npm run check` | Complete desktop, Android, and tracked-secret quality gate |
| `npm run check:desktop` | Desktop tests, typechecks, and production bundle |
| `npm run check:android` | Android tests, lint, and debug APK |
| `npm run dist:mac` | Signed local macOS DMG and ZIP |
| `npm run dist:win` | Machine-wide Windows x64 NSIS installer |
| `npm run install:mac:all-users` | Install app and all-user LaunchAgent (run with sudo) |
| `npm run sync-server` | Start the self-hosted sync service |

## Troubleshooting

- **Mac trigger does nothing:** grant Input Monitoring to Echo/EchoKeyHelper, then fully quit and
  reopen Echo. Check Diagnostics.
- **Auto-paste blocked:** grant Accessibility to Echo/EchoPasteHelper. The transcript remains on
  the clipboard and in History when paste is blocked.
- **Windows trigger does nothing:** do not mix privilege levels. Echo must run elevated when the
  target app is elevated.
- **Wrong-language text:** keep language `en` and use Maximum accuracy. Current builds reject the
  known foreign-script drift instead of inserting it.
- **No transcript:** verify the selected microphone, endpoint, API key, and English speech pack.
- **Android cannot insert:** enable the Echo keyboard, or grant the floating mic Accessibility and
  draw-over-apps permissions.

## Data and security

- `secrets.local.json`, Android `defaults.local.properties`, databases, retained audio, and build
  output are gitignored.
- Desktop secrets are stored per user in a mode-`0600` local settings file. This avoids a hidden
  Keychain prompt blocking all-user launch. Android secrets use EncryptedSharedPreferences backed
  by the Android keystore.
- Audio goes only to the configured speech endpoint. Cleanup/adjudication text goes only to the
  configured AI endpoint. Audio retention is user-configurable on desktop and off-phone.
- No credential is committed to this repository.

## Verification

See [cross-platform verification](docs/cross-platform-verification.md) for the tested matrix,
artifact checks, and the remaining Windows on-device checklist.

## License

MIT
