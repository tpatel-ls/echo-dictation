# Echo — Android voice keyboard

A dictation-only IME (input method) for Android: tap the mic, speak, and the Whisper
transcript is committed into whatever app you're typing in. History + dictionary sync with
desktop Echo through the same self-hosted sync service.

> **Authored, not built, on the desktop dev machine** (it has no Android toolchain). Open
> this `android/` folder in Android Studio to build/install. Pure logic (WAV encoding,
> dictionary apply/bias, sync merge, Whisper JSON parse) has JUnit tests under
> `app/src/test/` that run on a plain JVM — `./gradlew test` — no emulator needed.

## Layout

```
android/
  app/
    src/main/AndroidManifest.xml     IME service + config Activity + RECORD_AUDIO/INTERNET
    src/main/res/xml/method.xml      input-method metadata
    src/main/java/com/tanay/echo/
      audio/        AudioRecord capture + WAV encoder      (port of src/shared/wav.ts)
      dictionary/   applyDictionary + buildBiasPrompt       (port of src/shared/dictionary.ts)
      transcription/Whisper client + response parse         (port of src/main/transcription/whisper.ts)
      sync/         shouldApply/advanceCursor + SyncClient   (port of src/shared/sync.ts + src/main/sync/*)
      data/         Room entities/DAOs (transcripts, dictionary)
      ime/          EchoImeService + keyboard view
      settings/     SettingsActivity (endpoints, keys, enable-keyboard flow)
    src/test/java/com/tanay/echo/    JUnit tests mirroring the TS tests
```

The full one-page build + install + endpoint-setup guide lives in
[`../docs/android-build-and-install.md`](../docs/android-build-and-install.md).
