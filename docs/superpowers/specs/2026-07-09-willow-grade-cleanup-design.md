# Echo — Willow-grade dictation cleanup & cross-device ship (2026-07-09)

## Goal

Match Willow Voice's perceived accuracy: every dictation comes out properly punctuated,
organized into paragraphs, obeying spoken formatting commands ("leave space", "new
paragraph"), and formatted as a real email when the user is writing one. Ship the result
to macOS (this machine), Windows (cross-built artifact), and Android (Echo IME APK).

## Context (verified)

- Whisper server: self-hosted "GB10 Whisper" on the tailnet, model `whisper-1 → large-v3-turbo`.
  Accepts `file, model, response_format, language, temperature, prompt`. Raw STT quality is
  already strong; the gap is post-processing.
- Live Mac settings had `cleanupMode: "off"` — no cleanup ever ran. Default in code was `off` too.
- No voice-command handling existed anywhere in the codebase.
- Android IME is fully authored under `android/` but never compiled on this Mac (no JDK/SDK).
- This Mac's working copy is NOT a git repo; it is the newest source. Windows machine has its
  own older copy. Cross-build from here so all platforms ship the same code.

## Decisions (user-approved 2026-07-09)

1. **Cleanup mode: `auto` for everything** — Willow-style always-on LLM pass (~1–2s added
   latency accepted). Flip `DEFAULT_SETTINGS` and the live settings on this Mac.
2. **Android**: install JDK + Android SDK on this Mac via Homebrew, build the APK here,
   hand over sideload instructions. (Cannot push to the phone remotely.)
3. **Windows**: cross-build unsigned Windows artifact from this Mac; user copies it over.

## Design

### 1. Deterministic voice-command layer (`src/shared/voice-commands.ts`)

Pure, unit-tested text transform applied right after dictionary correction, before AI
cleanup — so commands work in microseconds even if the AI endpoint is down, and the AI
sees already-applied line breaks.

- "new paragraph" / "next paragraph" / "leave (a) space" / "leave (a) gap" → `\n\n`
- "new line" / "next line" → `\n`
- Commands match as standalone spoken phrases (word-boundary, tolerant of surrounding
  punctuation/commas Whisper adds; case-insensitive). The command's own trailing punctuation
  is absorbed, preceding sentence punctuation is preserved, and the first letter after a
  break is capitalized; stray breaks at the start/end are trimmed.
- NOT converted when part of a longer noun phrase where it's clearly content (e.g. "a new
  paragraph about X" — heuristic: preceded by an article "a/the" keeps it literal).
- Ported 1:1 to Kotlin (`VoiceCommands.kt`) with mirrored JUnit tests.

### 2. Willow-grade cleanup prompt (`src/main/transcription/claude.ts`)

Rewrite `SYSTEM_PROMPT` to:
- Fix punctuation/capitalization, strip fillers & false starts (as today).
- Organize long dictations into logical paragraphs.
- Obey spoken meta-instructions embedded in the dictation ("start a new paragraph",
  "make that a bullet list", "all caps", "quote ... end quote") and REMOVE the
  instruction words from the output.
- Email mode: when the register is professional (Gmail/Outlook window) or the speaker
  clearly dictates an email ("write an email to X", greeting + sign-off patterns),
  format with greeting line, body paragraphs, and sign-off on separate lines.
- Never summarize, never add content, never answer the text. Glossary stays pinned.
- Keep the existing `looksLikeAssistantReply` guard.
- Same prompt text ported to the Android `Claude.kt`.

### 3. Transcription accuracy nudges (`whisper.ts` + Kotlin `Whisper.kt`)

- Send `temperature=0` (server supports it) for deterministic decoding.
- Keep dictionary bias prompt + deterministic replacement (already in place).

### 4. Defaults & live config

- `DEFAULT_SETTINGS.cleanupMode: 'auto'`.
- On this Mac: quit Echo, set `cleanupMode: "auto"` in
  `~/Library/Application Support/echo/settings.json`, relaunch after install.
- Android seeded defaults: cleanup auto.

### 5. Ship

- **macOS**: `npm run pack:mac`, install the new Echo.app over the old one, relaunch.
- **Windows**: `electron-builder --win` from this Mac (unsigned; portable/unpacked zip).
  Deliverable: `dist/` artifact + copy instructions.
- **Android**: brew `temurin` + `android-commandlinetools`, accept licenses, gradle
  `assembleDebug` → APK + sideload steps. JUnit tests actually run here now.

### Error handling

- Cleanup failure in `auto` mode must fall back to inserting the raw (dictionary- and
  command-corrected) text — never lose a dictation (existing behavior, keep tested).
- Voice-command layer is total (never throws); unknown phrasing passes through untouched.

### Testing

- TDD (per CLAUDE.md) for `voice-commands.ts`, prompt-glossary composition, whisper
  temperature field, settings default flip. Vitest suite + typecheck must stay green.
- Kotlin: mirrored JUnit tests, run for real once the toolchain is installed.
- End-to-end: probe the live Whisper endpoint with `scripts/test-whisper.mjs`; manual
  hold-key dictation sanity check after install.
