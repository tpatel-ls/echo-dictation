# Wispr-parity completion — Phase 4, Whisper Mode, desktop ports, and deferrals

**Date:** 2026-06-22 · **Status:** implemented (with two documented deferrals)

This closes out the Wispr Flow parity track. Phases 1–3 (context-aware tone, Command Mode, Snippets
on Android) shipped earlier. This doc covers the remaining work and the deliberate deferrals.

## Shipped

### Phase 4 — Multilingual (Android)
- `languageParam` (pure, tested) normalizes a setting to a Whisper `language` form field; blank/"auto"
  ⇒ omitted (Whisper auto-detects). A Settings field exposes it. Applies on dictation + command paths.

### Whisper Mode (Android)
- `boostGain` (pure, tested): amplifies quiet PCM toward a target peak before WAV encoding — only
  amplifies, caps the factor, clamps to 16-bit. A Settings toggle gates it. Helps whispered/soft speech.

### Desktop — Context-aware tone
- `shared/app-style.ts` (pure, tested): classify the active window title into a register
  (casual/professional/technical/neutral) and turn it into a cleanup-prompt directive. Wired into the
  desktop cleanup path, so auto-cleanup adapts tone to the focused app. Best-effort (titles are messy,
  browsers hide the site); unknown titles stay neutral.

### Desktop — Snippets
- `shared/snippets.ts` (pure, tested) + `SnippetsStore` (tested) + a synced `snippets` collection +
  pipeline expansion. Schema/payload match Android byte-for-byte, so snippets authored on the phone
  sync to and expand on the desktop. (No desktop authoring UI — sync covers it.)

### Desktop — Command Mode engine
- `claude.ts` `command()` (tested): applies a spoken instruction to text, sharing a `post()` helper
  with `cleanup()`. The transform engine is in place and tested.

## Deferred (with rationale)

### Desktop Command-Mode trigger
The `command()` engine is done, but wiring it to a desktop trigger needs **selecting text capture**
(send Ctrl+C, read the clipboard) and a **reliable command-vs-dictation signal** on the global-hotkey
path. Both have real races (the copy must land before we read; the clipboard must be saved/restored)
and can't be verified without running on the desktop. Shipping it blind risks clobbering the user's
clipboard or misfiring on ordinary dictation. **Decision:** defer the trigger to an on-device session;
keep the tested engine.

### Streaming / real-time cleanup
Echo uses batch Whisper + batch Claude. True streaming needs streaming ASR *and* streaming LLM against
the self-hosted proxies — a large architectural change. The latency that matters is already
user-controlled (Android context-driven tone keeps chat instant; desktop cleanup is opt-in via
`cleanupMode`). **Decision:** not a "phase" but an architecture change with low ROI here — deferred
as a deliberate non-goal (YAGNI). The batch pipeline is sound.

## Verification
- Android: full unit suite green; debug APK builds. Pure logic (languageParam, boostGain, AppStyle,
  CommandEdit, Snippets) is TDD-covered.
- Desktop: 211 vitest tests green (26 files); both tsconfig projects typecheck clean.
- On-device confirmation (as always) is the user's: language pinning, Whisper Mode on quiet speech,
  desktop tone adapting by app, and a phone-authored snippet expanding on the desktop.
