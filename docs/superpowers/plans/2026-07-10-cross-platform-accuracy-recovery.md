# Echo Cross-Platform Accuracy Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject wrong-language dictation, recover from weak Whisper output with independent candidates, and ship a reproducible accuracy-first build for macOS, Windows, and Android.

**Architecture:** A pure transcript-quality layer scores all candidates. Desktop and Android use the existing deterministic Whisper pass first, then invoke platform recognition and/or a recovery decode only when the selected accuracy mode requires it. A transcript-only OpenAI-compatible Responses call adjudicates disagreements; every result passes deterministic quality and assistant-reply guards before dictionary, formatting, insertion, and history.

**Tech Stack:** TypeScript, Electron, Vitest, Swift Speech framework, C#/.NET `System.Speech`, Kotlin, Android `AudioRecord`, OkHttp, JUnit, Gradle.

## Global Constraints

- Trigger-to-listening UI response targets less than 50 ms on a warm process; final transcription has no dishonest 50 ms guarantee.
- English-only mode is the default on macOS, Windows, and Android.
- Obvious non-English or assistant-reply output must never be silently pasted; any non-clean final candidate is a safe failure.
- All-candidate failure retains audio and creates a retryable history row.
- Idle background work remains event-driven with no polling and no resident ML model.
- Dictionary spellings and aliases remain deterministic and are applied after candidate selection.
- No credentials, personal endpoint names, retained personal WAVs, or transcript content enter git or diagnostic logs.
- New pure behavior follows test-driven development and mirrored desktop/Android semantics.

---

### Task 1: Shared Transcript Quality and Candidate Selection

**Files:**
- Create: `src/shared/transcript-quality.ts`
- Create: `tests/transcript-quality.test.ts`

**Interfaces:**
- Produces: `TranscriptAssessment`, `TranscriptCandidate`, `assessTranscript(text, options)`, `chooseTranscript(candidates, options)`.
- Consumes: glossary strings only; no Electron or network dependency.

- [ ] **Step 1: Write failing quality tests**

```ts
expect(assessTranscript('Einn snop og þá minn ekki röggli og feitsið gís.', { language: 'en' }).grade)
  .not.toBe('clean')
expect(assessTranscript('Oddváey, Foss, sýttir á.', { language: 'en' }).grade).not.toBe('clean')
expect(assessTranscript('How do I force figure out?', { language: 'en' }).grade).toBe('suspicious')
expect(assessTranscript('Deploy PostgreSQL on GB10.', { language: 'en', glossary: ['GB10'] }).grade)
  .toBe('clean')
expect(chooseTranscript([
  { source: 'remote-primary', text: 'Einn snop og þá minn ekki röggli.', elapsedMs: 400 },
  { source: 'native', text: 'It is not working correctly.', elapsedMs: 520 }
], { language: 'en' })?.source).toBe('native')
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run tests/transcript-quality.test.ts`

Expected: FAIL because `src/shared/transcript-quality.ts` does not exist.

- [ ] **Step 3: Implement deterministic assessment and ranking**

```ts
export type TranscriptGrade = 'clean' | 'suspicious' | 'reject'
export type CandidateSource = 'remote-primary' | 'remote-recovery' | 'native' | 'adjudicated'
export interface TranscriptAssessment { grade: TranscriptGrade; score: number; reasons: string[] }
export interface TranscriptCandidate { source: CandidateSource; text: string; elapsedMs: number }
export interface QualityOptions { language: 'en'; glossary?: string[] }
export function assessTranscript(text: string, options: QualityOptions): TranscriptAssessment
export function chooseTranscript(candidates: TranscriptCandidate[], options: QualityOptions): TranscriptCandidate | null
```

Implement explicit rejection for empty/punctuation-only content, `ð`/`þ`, assistant-reply phrases,
and decoder garbage. Mark multiple unexplained extended-Latin letters, low English evidence in four
or more words, and grammatically broken multiword English as suspicious without rejecting accented
names, technical phrases, or glossary terms. Ranking is
stable by score, then source priority `adjudicated`, `native`, `remote-primary`, `remote-recovery`.

- [ ] **Step 4: Verify GREEN and the existing formatting tests**

Run: `npm test -- --run tests/transcript-quality.test.ts tests/format.test.ts tests/dictionary.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/shared/transcript-quality.ts tests/transcript-quality.test.ts
git commit -m "feat: score dictation transcript quality"
```

### Task 2: Recovery Decode and Transcript-Only Adjudicator

**Files:**
- Modify: `src/main/transcription/whisper.ts`
- Create: `src/main/transcription/adjudicator.ts`
- Modify: `src/shared/types.ts`
- Modify: `tests/whisper.test.ts`
- Create: `tests/adjudicator.test.ts`
- Modify: `tests/seed.test.ts`

**Interfaces:**
- Consumes: `TranscriptCandidate`, `QualityOptions`, configured proxy URL/key.
- Produces: `transcribe(..., { temperature })` and `adjudicate(candidates, context, settings, key, deps)`.

- [ ] **Step 1: Write failing request and parser tests**

```ts
expect((request.body as FormData).get('temperature')).toBe('0.8')
expect(await adjudicate(candidates, 'Visual Studio Code', settings, 'KEY', deps(fetchMock)))
  .toBe('It is not working correctly.')
await expect(adjudicate(candidates, '', settings, 'KEY', deps(replyMock)))
  .resolves.toBeNull()
```

The mock Responses payload must use the real schema:

```ts
{ output: [{ type: 'message', content: [{ type: 'output_text', text: 'It is not working correctly.' }] }] }
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run tests/whisper.test.ts tests/adjudicator.test.ts tests/seed.test.ts`

Expected: FAIL for missing temperature option, adjudicator module, and `accuracyModel` setting.

- [ ] **Step 3: Implement temperature override and Responses adjudication**

```ts
export interface WhisperOpts {
  retries?: number
  timeoutMs?: number
  delay?: (ms: number) => Promise<void>
  prompt?: string
  temperature?: number
}

export async function adjudicate(
  candidates: TranscriptCandidate[],
  appContext: string,
  settings: Pick<Settings, 'claudeBaseUrl' | 'accuracyModel'>,
  apiKey: string,
  deps: AdjudicatorDeps = { fetch }
): Promise<string | null>
```

POST `${claudeBaseUrl}/v1/responses` with `store:false`, the configured `accuracyModel`, candidate
labels, app context, and glossary. The instruction says the speaker is definitely speaking English,
return only faithful transcript text, never answer it. Parse only `output_text`, then reject wrapper,
assistant-reply, and non-English output through Task 1.

Add `accuracyModel: 'gpt-5.4-mini'` to settings defaults and seed migration without changing existing
non-empty user values.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --run tests/whisper.test.ts tests/adjudicator.test.ts tests/seed.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/transcription/whisper.ts src/main/transcription/adjudicator.ts src/shared/types.ts tests/whisper.test.ts tests/adjudicator.test.ts tests/seed.test.ts
git commit -m "feat: add guarded transcription recovery"
```

### Task 3: Desktop Accuracy Coordinator and Safe Failure

**Files:**
- Create: `src/main/transcription/accuracy.ts`
- Modify: `src/main/dictation.ts`
- Modify: `src/main/store/history.ts`
- Modify: `src/main/store/history-file.ts`
- Modify: `src/shared/types.ts`
- Create: `tests/accuracy.test.ts`
- Modify: `tests/history.test.ts`

**Interfaces:**
- Consumes: primary Whisper dependency, optional `SecondaryRecognizer`, adjudicator, dictionary glossary.
- Produces: `recognizeAccurately(wav, request, deps): Promise<RecognitionOutcome>`.

- [ ] **Step 1: Write failing coordinator tests**

```ts
expect((await recognizeAccurately(wav, request, depsClean)).winner.source).toBe('remote-primary')
expect((await recognizeAccurately(wav, request, depsNative)).winner.source).toBe('native')
expect((await recognizeAccurately(wav, request, depsAdjudicated)).winner.source).toBe('adjudicated')
await expect(recognizeAccurately(wav, request, depsRejected)).rejects.toThrow('low confidence')
```

Cover `fast`, `balanced`, and `maximum` modes; remote retry only on suspicious/rejected output;
native timeout; adjudicator failure; and no-safe-candidate failure.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run tests/accuracy.test.ts tests/history.test.ts`

Expected: FAIL because coordinator and low-confidence history behavior are absent.

- [ ] **Step 3: Implement coordinator and integrate dictation**

```ts
export type AccuracyMode = 'fast' | 'balanced' | 'maximum'
export interface SecondaryRecognizer { transcribe(wavPath: string, locale: 'en-US'): Promise<TranscriptCandidate | null> }
export interface RecognitionOutcome { winner: TranscriptCandidate; candidates: TranscriptCandidate[] }
```

`maximum` starts native and primary concurrently, waits at most 1,500 ms for native, and adjudicates
meaningful disagreement. `balanced` uses native/recovery only for a non-clean primary. `fast` uses
primary plus rejection guard. Only a `clean` winner may be returned for insertion; all-suspicious or
all-rejected candidates throw the low-confidence error. `dictation.ts` writes one temporary WAV before recognition, always
deletes it after the pipeline, and copies it into retained history storage on success or low-confidence
failure. Remove the punctuation-only fast-path assumption: cleanup can still skip only after quality is
`clean`. Store the winning source in `model` metadata. Add `accuracyMode: AccuracyMode` to Settings
with default `'maximum'` so the coordinator and UI share one source of truth.

- [ ] **Step 4: Verify GREEN and full desktop unit suite**

Run: `npm test -- --run`

Expected: all Vitest files pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/transcription/accuracy.ts src/main/dictation.ts src/main/store/history.ts src/main/store/history-file.ts src/shared/types.ts tests/accuracy.test.ts tests/history.test.ts
git commit -m "feat: coordinate accurate desktop dictation"
```

### Task 4: macOS Speech Helper, Permission, and Diagnostics

**Files:**
- Create: `native/EchoSpeechHelper.swift`
- Create: `src/main/transcription/native-speech.ts`
- Modify: `scripts/build-native.mjs`
- Modify: `electron-builder.yml`
- Modify: `src/main/permissions.ts`
- Modify: `src/main/diagnostics.ts`
- Modify: `src/main/index.ts`
- Create: `tests/native-speech.test.ts`
- Modify: `tests/mac-signing.test.ts`

**Interfaces:**
- Produces: long-running NDJSON helper and `NativeSpeechRecognizer implements SecondaryRecognizer`.
- Consumes: temporary 16 kHz mono WAV path from Task 3.

- [ ] **Step 1: Write failing TypeScript protocol and packaging tests**

```ts
expect(parseSpeechLine('{"type":"result","id":"1","text":"Hello.","elapsedMs":42}'))
  .toMatchObject({ type: 'result', text: 'Hello.' })
expect(speechHelperPath('darwin', '/resources')).toBe('/resources/native/EchoSpeechHelper')
expect(builderConfig).toContain('NSSpeechRecognitionUsageDescription')
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run tests/native-speech.test.ts tests/mac-signing.test.ts`

Expected: FAIL because helper protocol and usage description are missing.

- [ ] **Step 3: Implement the signed Swift helper and adapter**

The helper protocol is:

```json
{"type":"ready","engine":"SpeechAnalyzer","authorization":"authorized"}
{"type":"transcribe","id":"uuid","path":"/private/tmp/echo.wav","locale":"en-US"}
{"type":"result","id":"uuid","text":"Hello world.","elapsedMs":342}
{"type":"error","id":"uuid","code":"not-authorized","message":"Speech Recognition permission is not granted"}
```

Use macOS 26 `SpeechAnalyzer`/`SpeechTranscriber` where available and legacy
`SFSpeechURLRecognitionRequest` as fallback. Embed helper bundle metadata during `swiftc`, link
`Speech`, and preserve existing stable code signing. Add the usage string to Electron Info.plist.
The adapter owns one child process, request map, 1,500 ms deadline, and graceful shutdown.
Diagnostics reports authorization and English asset/locale availability without requesting access.

- [ ] **Step 4: Compile and verify helper protocol**

Run: `npm run build:native`

Run: `printf '{"type":"check"}\n' | out/native/EchoSpeechHelper`

Expected: valid single-line JSON with authorization and engine status; no crash.

- [ ] **Step 5: Verify tests and commit**

Run: `npm test -- --run tests/native-speech.test.ts tests/mac-signing.test.ts`

```bash
git add native/EchoSpeechHelper.swift src/main/transcription/native-speech.ts scripts/build-native.mjs electron-builder.yml src/main/permissions.ts src/main/diagnostics.ts src/main/index.ts tests/native-speech.test.ts tests/mac-signing.test.ts
git commit -m "feat: add macOS speech fallback"
```

### Task 5: Desktop Microphone Selection and History Retry

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/renderer/overlay/capture.ts`
- Modify: `src/renderer/overlay/Overlay.tsx`
- Modify: `src/renderer/dashboard/pages/Settings.tsx`
- Modify: `src/renderer/dashboard/components/TranscriptRow.tsx`
- Modify: `src/renderer/dashboard/lib/api.ts`
- Create: `src/renderer/overlay/audio-device.ts`
- Create: `tests/audio-device.test.ts`

**Interfaces:**
- Produces: per-user `audioInputDeviceId`, device listing IPC, and `history.retry(id)`.
- Consumes: Task 3 recognition coordinator and retained history audio.

- [ ] **Step 1: Write failing microphone fallback tests**

```ts
expect(resolveAudioDevice('missing', devices)).toEqual({ deviceId: undefined, fellBack: true })
expect(resolveAudioDevice('built-in', devices)).toEqual({ deviceId: 'built-in', fellBack: false })
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run tests/audio-device.test.ts`

Expected: FAIL because resolver is missing.

- [ ] **Step 3: Implement settings, selector, and retry**

Add `audioInputDeviceId: string` with default `''` and expose the existing Task 3 `accuracyMode`.
The overlay applies `{ deviceId: { exact: selected } }`, then retries system
default on `OverconstrainedError`. Settings shows one compact microphone select and a three-option
accuracy select using current styles. History Retry invokes the current coordinator on retained audio;
disable Retry when `audio_path` is absent. Do not nest new cards or change the dashboard palette.

- [ ] **Step 4: Run UI typecheck and tests**

Run: `npm run typecheck && npm test -- --run tests/audio-device.test.ts tests/history.test.ts`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/preload/index.ts src/main/ipc.ts src/renderer/overlay/capture.ts src/renderer/overlay/Overlay.tsx src/renderer/dashboard/pages/Settings.tsx src/renderer/dashboard/components/TranscriptRow.tsx src/renderer/dashboard/lib/api.ts src/renderer/overlay/audio-device.ts tests/audio-device.test.ts
git commit -m "feat: add microphone choice and transcript retry"
```

### Task 6: Reproducible Windows Native Helpers

**Files:**
- Create: `native/windows/EchoKeyHelper/EchoKeyHelper.csproj`
- Create: `native/windows/EchoKeyHelper/Program.cs`
- Create: `native/windows/EchoPasteHelper/EchoPasteHelper.csproj`
- Create: `native/windows/EchoPasteHelper/Program.cs`
- Create: `native/windows/EchoSpeechHelper/EchoSpeechHelper.csproj`
- Create: `native/windows/EchoSpeechHelper/Program.cs`
- Create: `src/main/native/helper-path.ts`
- Modify: `scripts/build-native.mjs`
- Modify: `src/main/hotkey/listener.ts`
- Modify: `src/main/insert/paste-deps.ts`
- Modify: `src/main/permissions.ts`
- Modify: `src/main/dictation.ts`
- Modify: `package.json`
- Modify: `README.md`
- Create: `tests/helper-path.test.ts`

**Interfaces:**
- Produces: the same NDJSON helper contracts on Windows with `.exe` path resolution.
- Consumes: Task 3 `SecondaryRecognizer` and current clipboard/paste state machine.

- [ ] **Step 1: Write failing path and build-routing tests**

```ts
expect(helperPath('EchoKeyHelper', 'win32', 'C:\\Echo\\resources')).toBe('C:\\Echo\\resources\\native\\EchoKeyHelper.exe')
expect(helperPath('EchoSpeechHelper', 'darwin', '/Echo/Resources')).toBe('/Echo/Resources/native/EchoSpeechHelper')
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run tests/helper-path.test.ts tests/machine.test.ts tests/platform.test.ts`

Expected: FAIL because helper-path module is missing.

- [ ] **Step 3: Implement helpers and platform-aware builds**

Use `WH_KEYBOARD_LL` for modifier hold/release events, `SendInput` for copy/paste, and
`SpeechRecognitionEngine.SetInputToWaveFile` with `DictationGrammar` for English WAV recognition.
Publish `net8.0-windows` single-file `win-x64` executables with
`EnableWindowsTargeting=true`. `build-native.mjs` compiles Swift only on Darwin and invokes `dotnet
publish` only for a Windows target. Spawn with `windowsHide:true` and ignore injected keyboard
events. Disable Command Mode selection probing on Windows until a safe foreground-terminal detector
exists.

- [ ] **Step 4: Verify Mac-runnable routing and cross-publish when dotnet is present**

Run: `npm test -- --run tests/helper-path.test.ts tests/machine.test.ts tests/platform.test.ts tests/paste-clipboard.test.ts`

Run: `ECHO_NATIVE_TARGET=win32 npm run build:native`

Expected on this Mac after .NET installation: three `.exe` files under `out/native`; execution tests
remain Windows-only and are documented in `README.md`.

- [ ] **Step 5: Commit**

```bash
git add native/windows src/main/native/helper-path.ts scripts/build-native.mjs src/main/hotkey/listener.ts src/main/insert/paste-deps.ts src/main/permissions.ts src/main/dictation.ts package.json tests/helper-path.test.ts README.md
git commit -m "feat: make desktop helpers cross-platform"
```

### Task 7: Android Quality, Recovery, and English Migration

**Files:**
- Create: `android/app/src/main/java/com/tanay/echo/transcription/TranscriptQuality.kt`
- Create: `android/app/src/main/java/com/tanay/echo/transcription/Adjudicator.kt`
- Modify: `android/app/src/main/java/com/tanay/echo/transcription/Whisper.kt`
- Modify: `android/app/src/main/java/com/tanay/echo/ime/DictationController.kt`
- Modify: `android/app/src/main/java/com/tanay/echo/settings/EchoSettings.kt`
- Modify: `android/app/src/main/java/com/tanay/echo/settings/SettingsActivity.kt`
- Modify: `android/app/src/main/res/layout/activity_settings.xml`
- Modify: `android/app/src/main/res/values/strings.xml`
- Create: `android/app/src/test/java/com/tanay/echo/transcription/TranscriptQualityTest.kt`
- Create: `android/app/src/test/java/com/tanay/echo/transcription/AdjudicatorTest.kt`
- Modify: `android/app/src/test/java/com/tanay/echo/transcription/WhisperTest.kt`

**Interfaces:**
- Mirrors Task 1 grades/reasons and Task 2 Responses schema in Kotlin.
- Produces: `WhisperClient.transcribe(..., temperature: Double = 0.0)`.

- [ ] **Step 1: Write failing mirrored Kotlin tests**

```kotlin
assertEquals(Grade.REJECT, assessTranscript("Einn snop og þá minn ekki röggli.").grade)
assertEquals(Grade.CLEAN, assessTranscript("Deploy PostgreSQL on GB10.", listOf("GB10")).grade)
assertEquals("0.8", recordedRequest.body.readField("temperature"))
```

- [ ] **Step 2: Install JDK 17 if absent and verify RED**

Run: `./gradlew test --tests '*TranscriptQualityTest' --tests '*AdjudicatorTest' --no-daemon`

Expected: FAIL because Kotlin implementations are missing.

- [ ] **Step 3: Implement Android adaptive recovery**

Primary Whisper uses English and temperature 0. A non-clean result triggers temperature 0.8, then
the configured `/v1/responses` adjudicator. Validate output before dictionary and cleanup. If all
candidates reject, report ERROR and retain the history failure without committing text. Migrate blank
`language` to `en`; add accuracy model/mode preferences with `gpt-5.4-mini` and `balanced` defaults.
Do not introduce Android `SpeechRecognizer`, because it cannot consume Echo's buffered PCM and would
compete with `AudioRecord` for the microphone.

- [ ] **Step 4: Verify Kotlin suite and debug APK**

Run: `./gradlew test assembleDebug --no-daemon`

Expected: BUILD SUCCESSFUL.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/tanay/echo/transcription android/app/src/main/java/com/tanay/echo/ime/DictationController.kt android/app/src/main/java/com/tanay/echo/settings android/app/src/test/java/com/tanay/echo/transcription
git commit -m "feat: recover inaccurate Android dictation"
```

### Task 8: Release Verification, Installation, Artifacts, and Push

**Files:**
- Modify: `README.md`
- Modify: `docs/HANDOFF.md`
- Create: `docs/cross-platform-verification.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces reproducible release commands, local artifacts, installed macOS app, and pushed git state.

- [ ] **Step 1: Document exact per-platform build and permission flow**

Document macOS Microphone/Speech Recognition/Accessibility/Input Monitoring grants, Windows .NET
and English speech pack requirements, Android JDK/SDK and IME/accessibility grants, artifact paths,
and the honest latency contract.

- [ ] **Step 2: Run complete source verification**

Run: `npm run typecheck`

Run: `npm test -- --run`

Run: `npm run dist:mac`

Run: `./gradlew test assembleDebug --no-daemon` from `android/`.

Run: `npm run dist:win` after installing .NET SDK and publishing Windows helpers.

Expected: every executable command exits 0; any macOS limitation on executing Windows binaries is
recorded separately from compilation success.

- [ ] **Step 3: Install and validate macOS app**

Run: `sudo npm run install:mac:all-users`

Verify: stable code signature, LaunchAgent running, key/paste helpers trusted, speech helper `check`
returns JSON, packaged smoke exits 0, and retained failing WAV is rejected or replaced by a clean
native candidate.

- [ ] **Step 4: Verify artifacts and secret hygiene**

Confirm macOS DMG/ZIP, Android APK, and Windows installer paths. Run:

```bash
git grep -nE 'tail[[:alnum:]]+\.ts\.net|("|=)(whisperApiKey|claudeApiKey|syncToken)("|=)[[:space:]]*:[[:space:]]*[^"[:space:]]' -- ':!docs/superpowers/specs/2026-07-09-willow-grade-cleanup-design.md'
git status --short
```

Expected: no new secret/personal endpoint matches and only intended release documentation changes.

- [ ] **Step 5: Commit documentation and push**

```bash
git add README.md docs/HANDOFF.md docs/cross-platform-verification.md
git commit -m "docs: add cross-platform Echo release guide"
git push origin mac
```

Expected: `origin/mac` advances to the verified local HEAD.
