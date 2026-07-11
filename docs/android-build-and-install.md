# Echo for Android: build and install

Echo for Android is a native Kotlin app with two dictation surfaces: an Echo voice keyboard and a
floating mic that can paste into other apps. It shares the desktop English accuracy gate, learned
dictionary, snippets, history, cleanup, and sync service.

## Requirements

- Android Studio stable, or JDK 17 plus Android SDK 34.
- Android 8.0 (API 26) or newer.
- Network access from the phone to the configured Whisper, AI proxy, and optional sync endpoints.
- Tailscale on the phone when those endpoints are private tailnet services.

## Build

Open the repository's `android/` directory in Android Studio and let Gradle sync, or run:

```bash
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

The verified output is:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Install with Android Studio's Run button, tap the APK on the device, or use ADB:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Optional preconfigured personal APK

Create the gitignored `android/defaults.local.properties` before building:

```properties
whisperBaseUrl=https://your-whisper.example/v1
whisperApiKey=your-key
whisperModel=whisper-1
claudeBaseUrl=https://your-ai-proxy.example
claudeApiKey=your-key
claudeModel=claude-sonnet-4-6
accuracyModel=gpt-5.4-mini
syncBaseUrl=http://your-sync-host:8787
syncToken=a-long-random-token
```

These values seed empty settings on first launch. They are not committed. Without this file, the
same fields can be filled in from the app.

## First-run setup

1. Open **Echo**.
2. Enter the Whisper URL/key/model. Keep language as `en`.
3. Leave accuracy at **Maximum** for the safest English transcription.
4. Enter the AI proxy URL/key plus cleanup and adjudicator models.
5. Optionally enter the sync URL/token.
6. Tap **Save** and **Grant microphone**.

### Use the Echo keyboard

1. Tap **Enable Echo keyboard**.
2. Turn on **Echo Voice Keyboard** in Android input settings.
3. Focus a text field, open the keyboard switcher/globe, and choose Echo.
4. Hold the mic, speak, and release. Echo inserts only after confidence checks pass.
5. Use Echo's globe button to return to the regular keyboard.

### Use the floating mic

1. Grant **Draw over other apps**.
2. Enable **Echo accessibility** for paste access.
3. Allow notifications when Android requests them.
4. Turn on **Show the floating mic button**.

Tap once to start/stop hands-free dictation, or hold while speaking. The service stays light and
uses a foreground notification only while the floating surface is enabled.

## Accuracy behavior

- Blank or `auto` language from an older build migrates to English.
- Maximum mode sends five hypotheses concurrently at controlled temperatures.
- Candidate disagreements may be adjudicated through the configured Responses endpoint.
- The adjudicator sees ASR hypotheses, app package context, and dictionary spellings. It is told to
  reconstruct speech, never answer it.
- A reconstruction must match multiple recognition candidates in Maximum mode.
- Foreign script, known Icelandic drift, decoder repetition, empty output, and assistant replies are
  rejected. Low-confidence text is not inserted.

## Sync

Start the included service on a reachable host:

```bash
SYNC_TOKEN='a-long-random-token' npm run sync-server
```

Use that host URL and token in Android and desktop Settings. Sync runs when the keyboard opens,
after dictation, and on desktop intervals. It carries transcript text, learned dictionary entries,
and snippets; audio is never synced.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Echo is absent from keyboard switcher | Enable Echo under Android's on-screen keyboard settings. |
| Microphone prompt repeats | Open Echo and grant microphone permission from system app permissions. |
| Foreign-looking text is not inserted | Expected safety behavior; retry in Maximum mode and check microphone quality. |
| Transcribing then error | Verify endpoint reachability, API keys, and Tailscale connection. |
| Floating mic copies but does not paste | Grant Echo Accessibility and refocus a writable text field. |
| Sync is empty | Confirm sync host, token, and phone reachability; desktop catches up on its next pass. |

Android secrets are stored with EncryptedSharedPreferences backed by the device keystore. Audio is
uploaded only to the configured speech endpoint and is not retained on the phone.
