# Cross-platform verification

Verified on July 11, 2026 from the Apple Silicon release workspace.

## Behavior contract

- Warm trigger-to-recording feedback target: less than 50 ms.
- Final text latency: accuracy-first and dependent on endpoint/network latency.
- English-only recognition: explicit `language=en` plus deterministic rejection gates.
- Maximum mode: five concurrent remote hypotheses, grounded disagreement adjudication, and native
  speech when the desktop platform supports it.
- Failure behavior: retain retryable audio and insert nothing when confidence is low.
- Background behavior: event-driven global hook, hidden tray/menu app, no resident speech model.

## macOS arm64

Verified locally:

- Swift key, paste, and SpeechAnalyzer helpers compile and have stable local signatures.
- `/Applications/Echo.app` passes deep/strict code-sign verification.
- `/Library/LaunchAgents/com.tanay.echo.plist` is valid and running for the console user.
- Key helper reports Accessibility/Input Monitoring trust and remains at 0.0% idle CPU.
- Paste helper reports Accessibility trust.
- Speech helper reports `en_US` availability and transcribes a synthesized English control.
- A synthetic Right Option hold reaches the installed app's start/cancel state machine.
- Retained regression audio rejects known Icelandic-looking output rather than pasting it.

Artifacts:

- `dist/Echo-0.1.0-arm64.dmg`
- `dist/Echo-0.1.0-arm64-mac.zip`

## Windows x64

Verified by cross-build:

- Electron application shell is PE32+ x86-64.
- `EchoKeyHelper.exe`, `EchoPasteHelper.exe`, and `EchoSpeechHelper.exe` are PE32+ x86-64,
  self-contained, and packaged under `resources/native`.
- NSIS output is machine-wide and includes an HKLM hidden-startup entry for every user.
- Package scripts are regression-tested to force `--x64` on Apple Silicon hosts.

Artifact:

- `dist/Echo-0.1.0-setup.exe`

Required final checks on a Windows x64 device after installation:

1. Confirm Right Ctrl down shows the recording bar and release inserts text.
2. Confirm clipboard contents are restored after paste.
3. Confirm Echo starts hidden for two separate Windows user profiles after sign-out/sign-in.
4. Confirm disabling Launch at login causes that profile's hidden startup invocation to exit.
5. Install English (United States) Speech and confirm Diagnostics sees native speech.
6. Dictate into a normal and elevated app, matching Echo's privilege level for the latter.

The Mac can compile and inspect these executables but cannot execute Win32 hooks, SendInput, or
System.Speech. Those six checks are therefore intentionally not claimed as locally executed.

## Android 8+

Verified locally with JDK 17 and Android SDK 34:

- All 144 JVM/JUnit tests pass, including MockWebServer request/response tests.
- `lintDebug` passes without suppressed errors.
- `assembleDebug` produces a valid debug APK.
- English migration maps old blank/auto language settings to `en`.
- Fast/Balanced/Maximum settings are wired to both IME and floating-mic dictation.
- Foreign-script/reply outputs fail closed; Maximum mode requires multi-candidate support.

Artifact:

- `android/app/build/outputs/apk/debug/app-debug.apk`

Required phone checks are enabling the IME, granting microphone access, enabling floating overlay
and Accessibility when desired, and verifying reachability of the configured endpoints.

## Artifact manifest

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `dist/Echo-0.1.0-setup.exe` | 231 MB | `9e4ef953f140913a7257c849c33600e1e51bc5f196c853d45e5a1d11e48e6af8` |
| `dist/Echo-0.1.0-arm64.dmg` | 116 MB | `cddb608df6a608ccc8ee4c24d778ee5df4f4bdd9683e031252b43b09a7d98140` |
| `dist/Echo-0.1.0-arm64-mac.zip` | 116 MB | `d7fcbabcd06b13cc9720e56e8faedd1218548f1d28706bbfe9ebce2928bd3ce2` |
| `android/app/build/outputs/apk/debug/app-debug.apk` | 7.4 MB | `08c094de8d836f4d506a5bbf635d4e495228a266013c4092ff626c0c671ebdc1` |

## Release commands

```bash
npm test
npm run typecheck
npm run build
npm run dist:win
npm run dist:mac

cd android
./gradlew testDebugUnitTest lintDebug assembleDebug --no-daemon
```

Inspect artifacts:

```bash
file dist/win-unpacked/Echo.exe dist/win-unpacked/resources/native/*.exe
codesign --verify --deep --strict dist/mac-arm64/Echo.app
shasum -a 256 dist/Echo-0.1.0-setup.exe dist/Echo-0.1.0-arm64.dmg \
  android/app/build/outputs/apk/debug/app-debug.apk
```
