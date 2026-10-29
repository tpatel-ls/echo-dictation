# Agent setup guide

Set up a fresh fork of Echo with a local CPU speech model. No access to the original author's
machines, accounts, keys or network is required.

## Prompt to give your agent

> Set up this Echo fork using docs/HANDOFF.md. Check prerequisites, install dependencies,
> download the local speech model, build native helpers, run checks, and start Echo and its
> local server. Use localhost for speech. Leave AI cleanup and sync unconfigured unless I
> supply my own services. Preserve existing settings. Verify dictation into a text editor
> and tell me which permissions I need to grant.

## Prerequisites

- Windows 10/11 **x64**, or macOS with Xcode command-line tools (`xcode-select --install`).
  Automatic meeting capture needs Windows 10 build 20348+ or Windows 11.
- Node.js **22 LTS**, npm 10+, Git, and **64-bit Python 3.12** on PATH.
- Windows source builds require **.NET 10 SDK** (`dotnet --list-sdks`) for the meeting helper.
  Installed builds include their native runtime.
- About 2 GB free disk for tools, dependencies and the default model. Setup downloads public
  packages and model weights. After downloading, local transcription needs no Internet.
- Linux can run the speech server/tests; desktop hotkey and paste helpers support Windows/macOS.

## Fork and set up

Fork on GitHub, clone **your fork**, then run in its root:

```sh
npm ci
npm run setup:local
```

Setup creates `.venv-speech/`, downloads `base.en` into `.models/`, builds native helpers and
creates a gitignored `secrets.local.json` containing the loopback URL if that file is absent.
It preserves existing seeds and user profiles. `ECHO_PYTHON` can select a Python executable.
If a native build fails, install the platform toolchain and rerun setup.

## Start

Terminal 1, kept open:

```sh
npm run speech:start
```

Terminal 2:

```sh
npm run speech:check
npm run dev
```

Fresh source runs use the local seed. For an existing profile or packaged installer, configure
Echo **Settings** with these values:

| Setting | Value |
| --- | --- |
| Speech/Whisper base URL | `http://127.0.0.1:8178/v1` |
| Speech model | `whisper-1` (alias for the loaded local model) |
| Speech API key | Empty |
| Accuracy | Balanced |
| AI cleanup | Off until you configure your own AI service |
| Live preview | Off initially; enable on a fast enough machine |
| Meeting live and final models | `whisper-1` |
| Meeting cross-check and vocabulary models | Empty |
| AI proxy, sync and calendar | Empty unless configured by you |

Saved settings take precedence over defaults. The local server binds only to loopback and is
not accessible to other devices. Quit both terminal processes to stop the development setup.

## Verify

```sh
npm test
npm run typecheck
npm run build
npm run check:secrets
```

Test speech connectivity in **Diagnostics**. In a text editor, hold **Right Ctrl** on Windows
or **either Option** on Mac, say a sentence, release, and check the pasted text and History.
On Mac grant Microphone, Input Monitoring and Accessibility to Echo and its helpers, then
restart. On Windows allow desktop microphone access and use a text editor at the same privilege level.

For Windows meetings, join a short test call, speak on both sides, leave, and verify recording
ends and a transcript appears. Detection uses OS/app evidence; verify the actual calling app
and headset. Stop is always available in the capsule and tray.

Also test joining while muted, moving the call to a background tab, and leaving the tab open
after hanging up. Google Meet's accessible **Leave call** control confirms a joined call even
when silent and muted. When that control is unavailable, Echo uses the meeting's own playback
signal or native meeting evidence; the mic channel begins paused. If the capsule says **Not recording —
confirm call**, use **Record now** in the capsule, Meetings page or tray. A persistent detection
error means automatic capture is unavailable; Echo retries and displays the error until recovery.

Google Meet names are read from its accessible participant controls on Windows. Keep the Meet
tab selected in a browser window for the best metadata coverage; opening Meet's People panel
exposes more of the roster. Background tabs, collapsed controls, browser accessibility and UI
language can limit what is available. Echo keeps names it has seen throughout the call. A
partial roster is displayed as attendees, but is never used to assign every voice to one person.
Slack direct-message names also come from its window title. Calendar matching remains optional.
Set your meeting display name to your full Google Meet name to avoid listing yourself twice.

The local server labels the channels **you / others**. Separating individual remote speakers,
remembering voices and writing AI notes/topic titles need optional additional services. A complete
one-to-one Meet roster can name the remote channel without diarization. Group-call voice labels
need voice matches or user confirmation; attendee names alone do not identify each speaker.

During recording, the transcript is a **Live draft** with remote voices grouped together.
After the call, the transcript shows processing progress and refreshes when the final speaker
pass finishes. Click a final speaker label to select a captured attendee or enter a name.
Leave **Remember this voice** checked to use a usable voice sample for future matches; Echo
reports when no usable sample is available. Confirm identities from the conversation or audio,
not by eliminating names from a partial roster. Grouped remote audio cannot be assigned to one
person when several remote attendees are known; configure diarization and use **Reprocess**.

If final processing fails, existing transcript text stays available with a **Review** warning.
If no text was recovered, the meeting shows a failure with the reason. Both cases retain audio
for Reprocess, even with zero-day retention. Delete the meeting explicitly to remove that audio.
Automatic endings require a fresh join or a period of absence before auto-recording again;
**Record now** remains available if a real rejoin cannot be confirmed. A failed start/stop
acknowledgement terminates the recorder so capture cannot silently continue.

## Model choices

`base.en` makes laptop setup easy. Use `small.en` for better CPU accuracy, or `large-v3-turbo`
with a supported NVIDIA GPU. Quality and latency depend on the model/hardware.
Set the same variables during setup and every server start:

```powershell
# PowerShell: a larger CPU model
$env:ECHO_SPEECH_MODEL = 'small.en'
npm run setup:local
npm run speech:start
```

```sh
# macOS shell
export ECHO_SPEECH_MODEL=small.en
npm run setup:local
npm run speech:start
```

`ECHO_SPEECH_DEVICE=cuda` and `ECHO_SPEECH_COMPUTE=float16` need a compatible NVIDIA driver,
CUDA 12 and cuDNN 9. Apple Silicon uses CPU here, not Metal. `ECHO_MODEL_CACHE` selects the
weight cache; `ECHO_SPEECH_PORT` changes port 8178 (also update Echo's URL). Only configure
model names your server actually serves. Advanced GPU services are in
[advanced-speech-servers.md](advanced-speech-servers.md).

## Use your own services

Enter your own URL, model and optional key in Settings. Dictation uses OpenAI-compatible
`POST /v1/audio/transcriptions`. Meetings additionally use `/v1/audio/segments`; the bundled
server implements both. `/v1/audio/diarizations` is optional, with two-channel fallback.
AI cleanup/notes use Anthropic-compatible `/v1/messages`; adjudication uses `/v1/responses`.
AI and sync are separate from speech and not required for local dictation.

## Package

```sh
npm run dist:win  # Windows x64 installer
npm run dist:mac  # On Mac: locally signed DMG/ZIP
```

Installers **never bundle `secrets.local.json` or model weights**. Set the speech URL after
installing and keep the speech server running. The installer does not install Python or a
background model service. Windows installers are unsigned; macOS signing is local.

## Development map

- `src/main/meetings/`: recording, live/final transcription, notes and calendar.
- `src/shared/meeting-session.ts`, `meeting-detect.ts`: detection/lifecycle.
- `local-speech/`: portable API and Python tests; `servers/gpu/`: optional larger services.
- User data: `%APPDATA%\echo` on Windows; `~/Library/Application Support/echo` on Mac.
- `ECHO_USER_DATA` selects an isolated test profile. Never commit profiles, audio or transcripts.

Python checks: install `local-speech/requirements-dev.txt` into `.venv-speech`, then run its
Python with `-m unittest discover -s local-speech -p "test_*.py"`. Tests do not download models.
