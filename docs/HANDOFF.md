# Echo developer handoff

Echo now has one accuracy contract across macOS, Windows x64, and Android. The active release branch
is `mac`; it includes the desktop Electron app, Swift/C# native helpers, native Android app, and sync
service.

## Current architecture

- `src/shared/transcript-quality.ts`: deterministic English quality and assistant-reply gate.
- `src/main/transcription/accuracy.ts`: desktop candidate coordination and grounded selection.
- `src/main/transcription/adjudicator.ts`: OpenAI-compatible Responses adjudication.
- `native/*.swift`: signed macOS key, paste, and SpeechAnalyzer helpers.
- `native/windows/*`: self-contained x64 key, paste, and System.Speech helpers.
- `android/app/src/main/java/com/tanay/echo/transcription/*`: mirrored Kotlin quality, recovery,
  adjudication, Whisper, formatting, and cleanup.
- `src/main/store/*`, `src/main/sync/*`, `src/server/*`: history, learned dictionary, snippets, and
  cross-device sync.

## Release commands

```bash
npm install
npm test
npm run typecheck
npm run dist:win
npm run dist:mac

cd android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

macOS builds require the local `Echo Local Code Signing` identity. Run
`npm run ensure:mac-signing` before packaging. Install to all Mac users with:

```bash
sudo npm run install:mac:all-users
```

Windows packaging is pinned to x64 and creates a machine-wide installer. The C# helpers can be
cross-published on this Mac, but Win32 hooks, SendInput, and System.Speech still require final
execution checks on a Windows x64 machine.

## Non-negotiable behavior

- English requests explicitly send `language=en`.
- Assistant replies and obvious wrong-language drift are never pasted.
- Maximum mode adjudication must be supported by recognizer candidates.
- Low-confidence audio is retained for retry; Echo inserts nothing.
- The global key helper is event-driven with no idle polling/model process.
- Trigger-to-overlay feedback targets under 50 ms; network transcription is not described as a
  sub-50-ms operation.
- Credentials and personal endpoints remain in ignored local files.

Use [cross-platform verification](cross-platform-verification.md) as the release checklist.
