# Echo for Android — build & install

Dictate into **any** Android app with the same Whisper accuracy as desktop Echo, with history
and dictionary syncing both ways. The app is authored in this repo under `android/` but is
**built and installed by you** in Android Studio (the dev machine has no Android toolchain).

Total time: ~20 minutes, most of it the first Gradle sync.

---

## 0. Prerequisites

- **Android Studio** (latest stable) — it bundles the right JDK and Android SDK. Download from
  <https://developer.android.com/studio>.
- An **Android phone** running Android 8.0 (API 26) or newer.
- The phone on your **tailnet** — install the **Tailscale** app on the phone and sign in, so it
  can reach the Mac Mini's Whisper and sync endpoints exactly like the desktop does.
- Your **sync service running** on the Mac Mini (see [`../src/server/README.md`](../src/server/README.md)).
  Quick version, from the repo root on the Mac Mini:
  ```bash
  npm install
  SYNC_TOKEN='choose-a-long-shared-secret' npm run sync-server   # listens on :8787
  ```
  Keep that `SYNC_TOKEN` — you'll paste it into the phone in step 3.

---

## 1. Open the project

1. In Android Studio: **File ▸ Open** → select the `android/` folder in this repo (open the
   `android` directory itself, not the repo root).
2. Let **Gradle sync** finish. The first sync downloads the Android Gradle Plugin, Kotlin, Room,
   OkHttp, etc. If prompted to install an SDK platform or build-tools, accept.

> The Gradle wrapper (`gradlew` / `gradlew.bat`, pinned to Gradle 8.7) is committed, so the
> command line works directly — no Android Studio required. This project has been built and its
> unit suite run on a clean toolchain (JDK 17 + Android SDK 34): **61 JUnit tests pass and
> `assembleDebug` produces a ~7.6 MB APK.**

## 2. Build & install the app

**Easiest (USB):** plug in the phone, enable **USB debugging** (Settings ▸ Developer options),
pick it in the device dropdown, and press **Run ▶**. Android Studio builds a debug APK and
installs it.

**Or build an APK to sideload:**
```bash
cd android
./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```
Transfer that APK to the phone (USB, Drive, etc.), tap it, and allow "install from this source".

> Sanity-check the pure logic first if you like — these run on your machine, no emulator:
> ```bash
> cd android && ./gradlew test
> ```
> They mirror the desktop's passing unit suite (WAV bytes, dictionary apply/bias,
> `shouldApply`/`advanceCursor`, the monotonic clock, the Whisper + sync clients).

## 3. First-run setup

Open the **Echo** app (it launches the setup screen). Fill in:

| Field | Value |
| --- | --- |
| **Whisper base URL** | `https://<your-whisper-host>/v1` (same as desktop) |
| **Whisper API key** | your Whisper key |
| **Whisper model** | `whisper-1` (pre-filled) |
| **Sync service URL** | `http://<your-mac-mini-tailnet-host>:8787` |
| **Sync token** | the `SYNC_TOKEN` from step 0 |
| *AI cleanup (optional)* | leave **off** for lowest latency; if you want it, toggle on and add a Claude-compatible base URL + key |

Tap **Save**. Then the two one-tap setup actions:

1. **Enable Echo keyboard** → opens system *Languages & input ▸ On-screen keyboards* → turn
   **Echo Voice Keyboard** on (Android warns that a keyboard can read what you type — expected
   for any IME; Echo only sends audio to *your* Whisper endpoint).
2. **Grant microphone** → tap **Allow**.

## 4. Dictate anywhere

1. In any app, focus a text field and bring up the keyboard.
2. Tap the **🌐 globe** key (or the on-screen keyboard-switcher) and pick **Echo Voice Keyboard**.
3. **Press and hold the mic**, speak, and **release** — the transcript is inserted into the
   field. The status pill mirrors the desktop: *Listening → Transcribing → Inserted*.
4. Tap the **🌐 globe** on the Echo bar to switch back to your normal keyboard to type by hand.

The mic is pre-warmed when the keyboard opens, so the first press has no cold-start delay. Your
dictionary biases Whisper and is applied to every result, exactly like desktop.

## 5. Verify sync

- Dictate a sentence on the phone → open the desktop dashboard's **History**; it appears there.
- Add/teach a word on the desktop → it biases and auto-corrects on the phone (it pulls the
  dictionary each time the keyboard opens).
- Deletes propagate both ways (tombstones).

Sync runs on keyboard-open and after each dictation; it's best-effort, so a brief tailnet blip
never blocks dictation — it catches up on the next pass.

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Echo isn't in the keyboard switcher | Re-do step 3.1 — it must be enabled in system input methods. |
| Pill says "Open Echo to set your endpoints" | Whisper URL or key is blank — open Echo, Save them. |
| Pill says "Tap to grant microphone access" | Tap the mic once → it opens settings → **Grant microphone**. |
| "Transcribing…" then an error | Phone can't reach Whisper — confirm Tailscale is connected and the URL matches desktop. |
| Nothing syncs | Confirm the sync service is running on `:8787`, the phone reaches the Mac Mini over the tailnet, and the **Sync token matches** `SYNC_TOKEN`. |
| Gradle sync fails | Let Android Studio install the prompted SDK/build-tools, then **File ▸ Sync Project with Gradle Files**. |

## Notes

- Secrets (keys/token) are stored in **EncryptedSharedPreferences** (Android keystore), never in
  source. No personal endpoint is baked into the APK — you enter yours once on the setup screen.
- This is a **dictation-only** keyboard (no QWERTY) — switch back to your normal keyboard to type
  by hand. That's intentional (see the design spec).
- Audio is never synced or stored on the phone — only text transcripts + the dictionary sync.
