# Context-aware tone & formatting (Phase 1 of the Wispr-Flow parity track)

**Date:** 2026-06-22 · **Platform:** Android (desktop deferred to a follow-up) · **Status:** implemented

## Goal

Make dictation auto-adapt its writing style to the app you're dictating into — casual in chat,
polished/professional in email, neutral in docs — the signature "it knew what I meant" Wispr Flow
behaviour. Echo already records the focused app (`app_context`) and already has a Claude cleanup
pass; this feature feeds the app identity into that pass.

## Decisions (locked with the user)

1. **Tone mechanism — smart built-in defaults.** A curated `package → register` map, with AI
   inference for unknown apps. Zero setup. (Rejected: a user-built rules engine; pure per-call AI
   inference.)
2. **Latency — context-driven effort.** The *same* map decides both the register *and* whether to
   spend the AI pass at all. Chat apps stay instant (raw transcription + dictionary, no AI wait);
   email/docs/unknown get the AI polish. (Rejected: AI on every dictation; ride-along with a global
   cleanup toggle.)
3. **Scope — Android first.** Clean app identity via package names (IME `EditorInfo.packageName`,
   floating button accessibility focus). Desktop (window-title / browser detection) is a later spec.

## Architecture

- **`transcription/AppStyle.kt`** (new, pure, JVM-tested): `Register` enum, `StyleProfile(register,
  runCleanup)`, `styleForPackage(pkg)` (the curated map), `styleDirective(register, appHint)` (the
  per-app system-prompt line; `null` for NEUTRAL). Android-free so it ports to desktop later.
- **`transcription/Claude.kt`**: extracted pure `buildCleanupSystem(glossary, styleDirective)` that
  layers base prompt → pinned glossary → optional style line; `ClaudeClient.cleanup()` gains an
  optional `styleDirective` param. Existing "don't summarize/translate/add content" guard is retained.
- **`ime/DictationController.kt`**: computes `styleForPackage(appContext)` (pure, instant), uses
  `profile.runCleanup` to gate the Claude call, and passes `styleDirective(register, pkg)` in. Gated
  by the `contextToneEnabled` setting.
- **Settings**: `EchoSettings.cleanupEnabled` (blunt global) → `contextToneEnabled` (default **on**;
  a no-op until Claude is configured). `SettingsActivity` switch + strings relabelled
  "Adapt formatting to the app".

### Default app → register map

| Register | Effort | Apps |
|---|---|---|
| Casual | instant, no AI | WhatsApp, Telegram, Messenger, Instagram, Snapchat, Discord, Signal, Viber, Google/Samsung Messages, X, Reddit, Slack, Teams |
| Professional | AI polish | Gmail, Outlook, Samsung/Yahoo/Proton Mail, LinkedIn |
| Neutral | AI polish | Keep, Google Docs, Word, Notion, Obsidian, Evernote, all browsers (site unknown) |
| Technical | AI polish | Termux, GitHub |
| Infer | AI polish | anything unknown (model infers from the package name; no `PackageManager`, no new permission) |

## Testing

- `AppStyleTest` (10): map returns the right register + `runCleanup` for chat / email / notes /
  browser / unknown / blank; `styleDirective` text per register, `null` for neutral, graceful blank hint.
- `ClaudeTest` (+4): `buildCleanupSystem` layers base → glossary → directive in order.
- Full suite green; clean compile.

## Deferred / follow-ups

- **Desktop port** of `AppStyle` (window-title + browser-URL identification — the hard part).
- Per-app overrides UI; light cleanup for casual apps; reading the browser address bar for site-aware
  tone. Later Wispr-parity phases: Command Mode, Snippets, Multilingual UX.

## On-device verification

Dictate the same sentence into WhatsApp (instant, near-raw) vs. Gmail (polished, professional) and
confirm the register differs and chat has no added latency.
