# Echo Dictation

Dictation for Windows x64, macOS and Android. Hold a global key, speak, release, and Echo
pastes the transcript into the focused app. It includes searchable history, learned dictionary
corrections, snippets, and optional Windows meeting transcription.

**Run with a local speech model or configure your own server. No private infrastructure is required.**

## Quick start for a fork

Give your agent [the setup guide](docs/HANDOFF.md). It covers prerequisites, models, permissions,
verification and packaging for Windows and Mac.

Install Node.js 22 LTS and Python 3.12. Windows source builds also need .NET 10 SDK;
Mac builds need Xcode command-line tools. Fork and clone the repository, then:

```sh
npm ci
npm run setup:local
```

Start the model in one terminal:

```sh
npm run speech:start
```

In another:

```sh
npm run speech:check
npm run dev
```

Setup downloads the English `base.en` model and builds native helpers. A fresh source run
uses `http://127.0.0.1:8178/v1`, model `whisper-1`, with **no API key**. Existing profiles keep
their saved settings; change the URL/model in Settings if necessary. Local model inference
runs on your computer. Internet access is needed for the initial dependency/model download.

Hold **Right Ctrl** on Windows or **either Option** on Mac to dictate. macOS requires
Microphone, Accessibility and Input Monitoring permissions. Start with **Balanced** accuracy;
live preview is optional, and AI cleanup stays off until you configure an AI service.

## Choose your setup

| Feature | Included local setup | Optional services |
| --- | --- | --- |
| English dictation | Local Whisper model on CPU | Your OpenAI-compatible speech endpoint |
| Dictionary, snippets, history | Local | Self-hosted sync |
| Windows meeting transcript | Local model; you / others channels | Remote-speaker diarization and voiceprints |
| AI cleanup, meeting notes | Requires configuration | Your Anthropic-compatible AI endpoint |
| Adjudication | Requires configuration | Your Responses-compatible AI endpoint |

`base.en` is lightweight. Use `small.en` for higher CPU accuracy or a supported NVIDIA GPU
with a larger model. See [model options](docs/HANDOFF.md#model-choices). Quality and speed
vary with hardware and model; the local setup does not claim large-server accuracy.

All service URLs and credentials are yours to configure in **Settings**. No speech, text,
calendar or sync traffic goes to an author's personal service. TypeSafe verification is an
optional named third-party integration and is used only when its key is configured.

## Meetings on Windows

Echo detects supported Meet, Teams, Slack huddle, Zoom and Webex calls using microphone
sessions and app/window evidence. The capsule and tray show recording state and provide
**Stop**, **Discard**, and **Pause my mic**. Test detection with your particular app/headset;
mute and hang-up behavior varies across apps. Tell participants when recording.

Echo rescans supported app/window and tab metadata every five seconds while idle, so muted
joins and missed microphone events can still be discovered. Google Meet playback alerts and
native meeting windows can confirm a muted join; your microphone starts paused in that case.
Browser labels can include extra metadata. Unclear call evidence shows **Not recording — confirm
call**, with **Record now** in the capsule, Meetings page and tray. A detector outage stays visible
while Echo retries. Recording-start failures get two delayed retries before requiring Record now.
Detection does not read page contents. A tab title alone never starts an automatic recording.

The final transcript uses retained audio. Missing speaker separation falls back to channel
labels. Failed or empty transcription keeps the recording and earlier transcript for retry,
with an error shown on both Notes and Transcript tabs. Reprocess retries from retained audio.
Google Meet codes become readable titles from a matching calendar event or notes summary.
Existing notes also provide readable list titles without requiring reprocessing.

Calendar is optional: enter your private ICS URL in Settings to match meetings and attendees.
Notes require your own AI configuration. Audio retention defaults to 30 days. Meeting audio,
transcripts and remembered voices stay outside cross-device sync.

## Build and verify

```sh
npm test
npm run typecheck
npm run build
npm run check:secrets
npm run dist:win   # Windows x64 installer
npm run dist:mac   # macOS DMG and ZIP, built on Mac
```

Installers exclude private seed files and model weights. After installation, start the local
speech server separately and enter its URL/model in Settings. Windows installers are unsigned;
macOS builds use a local signing identity. Release outputs go to `dist/` and are not tracked.

Android setup is documented in [its build guide](docs/android-build-and-install.md). Android
needs a speech endpoint reachable from the phone; `127.0.0.1` refers to the phone itself.
The loopback-only desktop server is deliberately not exposed to the network.

## Repository map

- [Agent handoff](docs/HANDOFF.md): reproducible local setup and troubleshooting.
- `local-speech/`: portable CPU/CUDA model server and API tests.
- `src/main/`, `src/renderer/`, `src/shared/`: Electron app and shared logic.
- `native/`: Swift and Windows .NET helpers; `android/`: native Android app.
- [Advanced GPU services](docs/advanced-speech-servers.md): optional larger models and diarization.
- [Sync server](src/server/README.md), [contributing](CONTRIBUTING.md), [security](SECURITY.md).

User data lives at `%APPDATA%\echo` on Windows and `~/Library/Application Support/echo` on Mac.
Credentials are per-user; desktop keys are stored in a restricted local file and Android uses
EncryptedSharedPreferences. Do not share user profiles, recordings, model caches or local seed
files. Share the GitHub fork or source repository instead.

MIT licensed. See [LICENSE](LICENSE).
