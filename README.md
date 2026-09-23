# Echo

Echo is an accuracy-first English dictation app for macOS, Windows x64, and Android. Hold a
global key on desktop or use the Android voice keyboard/floating mic, speak naturally, and Echo
inserts a faithful transcript at the cursor. It includes a compact bottom recording bar, searchable
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
6. Apply deterministic dictionary aliases, spoken punctuation/formatting, snippets, and automatic
   English cleanup for paragraphing, lists, number formatting, and self-corrections.
7. Balanced/Fast keep the best usable English candidate after bounded recovery. Maximum remains
   fail-closed and keeps retained audio available for retry when confidence is low.

The three desktop modes are:

- **Balanced** (default): one fast decode, with recovery only when its quality is not clean.
- **Maximum**: five concurrent remote hypotheses plus native recognition when available.
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

- `dist/Echo-0.2.0-arm64.dmg`
- `dist/Echo-0.2.0-arm64-mac.zip`

## Install on Windows for all users

Build from macOS or Windows:

```bash
npm install
npm run dist:win
```

Run `dist/Echo-0.2.0-setup.exe` and accept the UAC prompt. The NSIS installer is pinned to x64,
installs machine-wide, creates desktop/Start Menu shortcuts, and registers
`Echo.exe --hidden` under the 64-bit HKLM Run key so every user starts Echo at sign-in. Each user
still has separate settings/history and can disable **Launch at login**; a disabled profile exits
immediately when invoked by the machine startup entry.

The installer contains self-contained x64 helpers for the global keyboard hook, SendInput paste,
and `System.Speech`; the target PC does not need .NET. For the independent native recognizer,
install **English (United States)** under Windows **Time & language > Speech**.

The Windows installer is currently unsigned. Windows may show a SmartScreen warning on first run.
The local artifact is `dist/Echo-0.2.0-setup.exe`.

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

## Meeting notes (Windows)

Echo can transcribe the meetings you join and write notes afterwards. Turn it on or off in
**Settings › Meetings** (on by default on Windows; macOS shows it as unavailable).

- **When it records.** Only while a supported app holds your microphone *and* shows a meeting:
  Google Meet (Chrome, Edge, Brave, Arc, Firefox), Microsoft Teams, Slack huddles, Zoom and Webex.
  Each app can be switched off. A lobby does not start a recording until the other side is heard
  for more than a moment (a join chime does not count) or 90 s have passed. A browser using the mic
  for anything else (voice notes, ChatGPT) is not a meeting. Recording stops about 4 s after the
  meeting tab or window closes (15 s when Echo cannot tell), and anything captured after the call's
  last live moment is cut from the audio and the transcript. If the meeting app releases the mic
  while you are muted, recording continues only while the meeting is still on screen and the other
  side was heard in the last minute. Slack shows no huddle window, so a Slack huddle without your
  mic continues only while the other side is heard, and ends 15 s after they were last heard.
- **Always visible.** Echo's small bottom capsule (the one dictation uses) shows the meeting state:
  an amber dot for "Meeting detected" (hover for **Record now** / **Don't record**), a red dot and
  timer while recording (hover for **Pause my mic**, **Stop**, **Discard**, **Open**), "Saved ·
  writing notes" when it ends, and a clickable "Notes ready" afterwards. Holding the dictation key
  always takes priority. The tray says so too. Windows notifications are off by default (Settings ›
  Meetings › "Also show Windows notifications"). Windows shows no microphone indicator for this kind
  of capture, so Echo's own indicators are the only cue. Tell the other participants you are
  recording; the laws differ by place.
- **Your mic while muted.** Nothing you say while muted should end up in a transcript. Echo pauses
  your mic channel (it records silence, and nothing reaches the disk) whenever the meeting app
  releases the microphone. You can also pause it yourself from the capsule, the tray, or the Meetings
  page ("Your mic: paused"). Some apps (Teams, Zoom, and usually Meet) keep the mic open while
  muted, and Echo cannot see their mute button, so use the pause there. The second before each
  pause is left out of the transcript as well.
- **Where things go.** Audio stays on this PC in Echo's data folder (`meetings\<id>\`) and is sent
  only to your own speech server. It is deleted 30 days after the meeting by default (0 deletes it
  as soon as the notes are ready). Notes are written by your AI proxy and, only when a TypeSafe key is
  set, each item is checked against the transcript by TypeSafe. The Markdown copy (notes and
  transcript) goes to `Documents\Echo Meetings` unless you choose another folder, named
  `YYYY-MM-DD HHmm <App> - <title>.md`.
- **Live and final transcripts.** A fast live transcript appears on the Meetings page during the
  call. After the call, a slower pass separates the speakers, decodes each turn with the most
  accurate model, names the speakers, and drafts notes that cite transcript lines. If the speaker
  separation service is unavailable, the transcript has one speaker per channel (you and
  "the others"). The final pass also sends a keyword list (your name, the attendees, remembered
  voices, then your dictionary words) with the audio. Canary-Qwen ignores it; Granite Speech on
  the GB10, the **vocabulary model**, uses it. Echo takes a word from Granite only where it
  replaces one word of Canary's text with a listed term that sounds like it ("Cloud" becomes
  Claude), never a word Granite added, so a listed name cannot appear where nobody said it (see
  `docs/gb10-asr-upgrade.md`). Clear **Vocabulary model** under Meetings › Advanced to turn it off.
- **Speaker names.** Echo never guesses a name. You are labelled with the name in Settings (or your
  Windows account name). Others are named by a voice you asked Echo to remember, by your calendar
  when the event has exactly one other attendee and one other person spoke ("from calendar"), or by
  the meeting window title when exactly one other person spoke (for example a Slack DM huddle).
  Everyone else is "Speaker N", with a suggestion when the conversation shows their name ("Hey
  Darin…") and, with a calendar, only when that name is an attendee. Names that speech recognition
  misspells ("Deren" for Darin, "Daren Kudira" for Darin Kadiro) are corrected in the text when the
  right name is known: yours, a calendar attendee's, or anyone whose voice Echo remembers. Click a
  speaker to name them; with **Remember this voice** (it needs about 10 s of their speech) future
  meetings recognise them. Remembered voices stay on this PC and can be forgotten at any time under
  **Remembered voices**.
- **Calendar (optional).** Echo can read your calendar's private iCal address to learn who is in
  a meeting. No sign-in, and nothing is sent anywhere but a download of that address (at most every
  10 minutes, and when a meeting starts).
  - Google Calendar: on calendar.google.com open **Settings**, pick your calendar under
    **Settings for my calendars**, open **Integrate calendar**, and copy **Secret address in iCal
    format**.
  - Outlook: **Settings › Calendar › Shared calendars › Publish a calendar**, publish with "Can
    view all details", and copy the ICS link.

  Paste it in Echo under **Settings › Calendar** and click **Save keys & token**. It is stored
  encrypted and shown masked. **Test** reports how many events you have today. Add **My calendar
  email** so you are not counted as an attendee. Treat the address like a password: anyone with it
  can read your calendar. If it leaks, reset it in Google Calendar.

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
- **Wrong-language text:** English is pinned automatically. Balanced retries suspicious output;
  Maximum can be selected when fail-closed multi-candidate agreement is preferred.
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
- Meeting audio, transcripts and remembered voices stay in the local database and data folder and
  are never synced. Meeting logs (`meetings.log`) hold ids, durations and error kinds only, never
  window titles, names or speech.
- No credential is committed to this repository.

## Verification

See [cross-platform verification](docs/cross-platform-verification.md) for the tested matrix,
artifact checks, and the remaining Windows on-device checklist.

## License

MIT
