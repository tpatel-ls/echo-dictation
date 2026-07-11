# Echo Cross-Platform Accuracy Recovery Design

## Goal

Make English dictation reliable on macOS, Windows, and Android by combining independent
recognition candidates, rejecting obvious wrong-language output, preserving dictionary and
formatting behavior, and keeping interaction feedback effectively instantaneous.

## Measurable Targets

- The recording overlay must react to a trigger within 50 ms on a warm app process.
- Final transcription latency is measured from key release to insertion and is accuracy-first.
  It cannot be guaranteed below 50 ms because it includes recognition and network work.
- Obvious non-English output must never be silently inserted when English-only mode is active.
- The captured recording must remain recoverable when every recognition path is low confidence.
- Background operation remains event-driven: no polling loop, model resident in Echo, or idle
  CPU work.
- macOS, Windows, and Android use the same quality and candidate-selection semantics.

## Verified Root Cause

Echo already sends `language=en`, but the configured transcription service maps every requested
model name to one `large-v3-turbo` backend. Replaying the retained failing WAV returned the same
Icelandic-looking text with explicit English, multiple model names, and deterministic decoding.
The recording is valid 16 kHz mono with strong signal-to-noise ratio. The desktop fast path then
mistook a capitalized, punctuated wrong-language sentence for clean output and skipped cleanup.

## Architecture

### 1. Shared Transcript Quality Contract

Add a pure, deterministic evaluator on desktop and a mirrored Kotlin implementation on Android.
It classifies a candidate as `clean`, `suspicious`, or `reject` and records reasons without trying
to invent replacement words. `reject` is reserved for deterministic evidence such as empty output,
explicit English-incompatible letters, decoder corruption, or assistant replies. Statistical or
ambiguous language evidence is `suspicious`; the coordinator, not the scorer, guarantees that a
non-clean candidate is never pasted without successful rescue.

Signals include:

- empty or punctuation-only output;
- English-only forbidden letters strongly associated with another language, including `ð` and
  `þ`;
- excessive non-ASCII letter density not covered by dictionary terms;
- missing English function-word evidence in a multiword sentence;
- assistant-style replies introduced by a text model;
- repeated or malformed token patterns that indicate decoder failure.

Names and dictionary terms are exempted from script heuristics. Short technical utterances are not
rejected merely because they contain no common English stop words.

### 2. Candidate Pipeline

The primary remote request remains deterministic: `language=en`, `temperature=0`, dictionary bias,
and the configured model. A clean result proceeds immediately. A suspicious or rejected result
starts rescue work:

1. request controlled remote decodes at medium and high recovery temperatures;
2. include the platform secondary recognizer when available;
3. send only the candidate texts, focused-app context, and dictionary terms to the configured
   OpenAI-compatible Responses endpoint using `gpt-5.4-mini` by default;
4. require a transcript-only English reconstruction based on phonetic agreement across the
   candidates, never a conversational reply or a blind preference for the most fluent candidate;
5. validate the response through the same quality and
   assistant-reply guards, and require close wording support from at least one recognizer so the
   adjudicator cannot invent a polished new sentence;
6. apply deterministic dictionary replacement, voice commands, snippets, and optional cleanup.

If adjudication is unavailable, choose the highest-quality clean independent candidate. If no
candidate is clean, save the audio and failed history row, show a concise retryable error, and do
not paste nonsense.

For maximum-accuracy mode on desktop, one temperature `0` decode, three independent temperature `0.3`
samples, one temperature `0.8` outlier, and the native
recognizer run concurrently after key release. Even a clean-looking primary is adjudicated when an
independent candidate disagrees, because fluent decoder errors can pass surface heuristics. Balanced
mode only rescues a non-clean primary. Android uses the remote rescue
path because `SpeechRecognizer` owns microphone capture and cannot consume Echo's existing PCM
buffer without replacing the IME recording architecture.

### 3. macOS Secondary Recognizer

Add a signed, long-running `EchoSpeechHelper` written in Swift. It accepts newline-delimited JSON
requests containing a temporary WAV path and locale, uses macOS 26 `SpeechAnalyzer` and
`SpeechTranscriber` with `en-US`, and falls back to `SFSpeechRecognizer` where the newer analyzer
is unavailable. It returns structured `ready`, `result`, and `error` events. Echo starts it lazily
and terminates it with the app, so idle cost is negligible.

The helper embeds bundle metadata, links the Speech framework, and requests Speech Recognition
authorization once per macOS user. The helper checks analyzer model-asset availability and reports
when macOS must download the English asset. The main app adds
`NSSpeechRecognitionUsageDescription`. Permission denial or an unavailable asset is a soft
failure: remote recognition continues and Diagnostics explains the exact setting to grant.

### 4. Windows Secondary Recognizer and Native Build

Add Windows C# helpers and make `scripts/build-native.mjs` platform-aware:

- `EchoKeyHelper`: low-level keyboard hook with the existing JSON event contract;
- `EchoPasteHelper`: clipboard paste through `SendInput`;
- `EchoSpeechHelper`: `System.Speech.Recognition.SpeechRecognitionEngine` configured for `en-US`
  and a WAV file input.

Windows compiles these helpers with its installed .NET Framework compiler during `npm run build`.
macOS builds only Swift helpers. The repository can produce a working Windows build after pulling
on a Windows machine; macOS cannot execute or fully validate Windows speech APIs.

### 5. Android Accuracy Recovery

Default language to `en` for new and existing blank-language installs. Mirror transcript-quality,
remote recovery decode, Responses adjudication, dictionary protection, and assistant-reply guards
in Kotlin. Keep `AudioRecord` as the single microphone owner so the IME and floating overlay remain
stable. The prewarmed recorder and HTTP connection preserve current interaction latency.

### 6. Microphone Selection and Audio Health

Desktop Settings gains a compact microphone selector populated from `enumerateDevices()`. The
selected device id is per user and falls back to the system default when unavailable. Capture
requests speech-oriented echo cancellation and noise suppression but does not silently switch to a
Bluetooth microphone. Diagnostics reports selected device, sample rate, duration, peak, clipping,
and low-signal warnings without storing additional audio.

The existing dark Echo interface remains intact. The selector uses the current field styling and
does not introduce a new visual system.

### 7. History, Retry, and Observability

History keeps raw, cleaned, audio, model, and latency fields. Model metadata records the winning
engine or `adjudicated` path. Failed low-confidence rows retain audio. Add a retry action that runs
the current accuracy pipeline against retained audio without recording again.

Stage timings are diagnostic only: trigger-to-listening, remote recognition, native recognition,
adjudication, cleanup, and insertion. Secrets, audio content, and full transcript text are never
written to diagnostic logs.

## Error Handling

- Native recognizer unavailable or unauthorized: continue with remote recognition.
- Remote transient error: retain existing bounded retries, then use a clean native candidate.
- Responses endpoint unavailable: deterministic candidate scoring chooses the best clean result.
- Text model emits an answer or explanation: reject it and use the best pre-adjudication candidate.
- All candidates rejected: retain audio, insert nothing, and expose Retry transcription.
- Missing preferred microphone: fall back to system default and surface that state in Settings.

## Testing

- TDD for quality scoring, candidate selection, adjudication parsing, assistant-reply rejection,
  platform routing, microphone fallback, and history retry.
- Retained-WAV regression tests verify that the Icelandic outputs are rejected in English mode.
- Swift helper protocol tests use checked-in generated test WAV fixtures without speech content;
  the retained personal recordings remain outside git.
- Kotlin unit and MockWebServer tests mirror desktop recovery behavior.
- Desktop: full Vitest suite, typecheck, production bundle, packaged smoke test, signing check, and
  installed-app launch test.
- macOS: helper protocol, Speech authorization state, retained-WAV replay, and end-to-end hotkey
  capture after installation.
- Android: JVM unit suite and debug APK build on this Mac after installing JDK 17 and required SDK
  components.
- Windows: cross-platform TypeScript tests run on this Mac; native helper compilation and end-to-end
  verification are documented and must run on Windows after pulling because Windows APIs cannot be
  executed on macOS.

## Distribution

- Install the signed macOS build in `/Applications/Echo.app` and restart the all-user LaunchAgent.
- Produce a macOS DMG/ZIP and Android debug APK as local artifacts.
- Keep all credentials in ignored seed files; no endpoint or secret enters git.
- Commit implementation and documentation on `mac`, then push `mac` to `origin` so other devices
  can pull the exact source and build with their platform toolchain.
