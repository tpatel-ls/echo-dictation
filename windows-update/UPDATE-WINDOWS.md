# Echo — Windows update (2026-07-09): Willow-grade cleanup + voice commands

Copy this whole `windows-update` folder to the Windows machine, open the Echo repo there,
and either follow the steps by hand or **paste this file into Claude Code on the PC and let
it do everything**.

## What this update does

1. **Voice commands** — saying "new paragraph" / "leave space" inserts a blank line, "new
   line" a line break. Deterministic, instant, works even if the AI endpoint is down.
2. **Willow-grade AI cleanup prompt** — organizes dictations into paragraphs, obeys spoken
   instructions ("make that a bullet list", "scratch that"), and formats real emails
   (greeting / body / sign-off) when you're dictating one.
3. **Whisper `temperature=0`** — deterministic transcription.
4. **Cleanup defaults to `auto`** — every dictation is cleaned before insert (Willow-style).
5. **No em dashes, ever** — the prompt forbids them AND a deterministic `stripEmDashes`
   pass scrubs any that slip through (mid-sentence dash → comma) before text is inserted.
6. **Accuracy hardening** — the prompt now says: correct only clear speech-recognition
   errors; when unsure keep the speaker's exact words.
7. **Paragraph-command fix (important)** — dictating "make a new paragraph and write that
   X" now writes X in a new paragraph instead of echoing the directions or leaking a
   "Here is the cleaned transcript:" preamble. This required FOUR coordinated changes in
   `claude.ts` (all in the bundled reference copy): the compose example in
   `SYSTEM_PROMPT`, the rewritten user-message framing in `cleanupUserContent` (the old
   "do not act on it" wording caused the echo bug), `temperature: 0` in the request body,
   and the `stripWrapper` scrub applied alongside `stripEmDashes`. Copy all of them.
8. **Clean spacing guaranteed** — `stripWrapper` now also kills "---"/"***" separator
   lines ANYWHERE (the model liked drawing horizontal rules between paragraphs) and an
   invented leading "Subject:" line. Speaker-placed line breaks travel through the model
   as ⟦PARA⟧/⟦LINE⟧ sentinel markers (`protectBreaks`/`restoreBreaks` in `claude.ts`,
   wired inside `cleanup()`) — raw newlines were getting merged by the model.
9. **Instant inserts for short dictations** — `needsAiCleanup` in the bundled `format.ts`
   (goes to `src/shared/format.ts`); in `dictation.ts` gate the auto-cleanup with it:
   `else if (s.cleanupMode === 'auto' && needsAiCleanup(raw))`. Short, already-punctuated
   dictations skip the AI round-trip and paste immediately.
10. **Connection pre-warm (~130-250 ms faster transcription)** — copy the bundled
    `prewarm.ts` to `src/main/transcription/prewarm.ts`. In `dictation.ts`: add a
    `private prewarm = new WhisperPrewarm()` field; call
    `this.prewarm.start(this.settings.getSettings().whisperBaseUrl)` in `onStart()` right
    after showing the pill, and `this.prewarm.stop()` at the top of `handleAudio()`, in
    `onCancel()`, and in the watchdog timeout handler. It pings the Whisper server's
    /health every 3 s while you speak so the transcription POST reuses a warm TLS socket.

The macOS and Android versions already ship all of this — the three platforms must stay in
lockstep so a dictation behaves identically everywhere.

## Steps

1. **Copy the two new files** into the repo (they are pure and platform-independent):
   - `voice-commands.ts` → `src/shared/voice-commands.ts`
   - `voice-commands.test.ts` → `tests/voice-commands.test.ts`

2. **Replace the cleanup system prompt and add the em-dash scrub.** The bundled `claude.ts`
   is the current macOS version for reference. If the Windows
   `src/main/transcription/claude.ts` has diverged, copy over from the bundled file:
   - the `SYSTEM_PROMPT` constant (the long one mentioning "spoken formatting
     instructions", email layout, and "Never use em dashes"),
   - the em-dash sentence at the end of `COMMAND_SYSTEM_PROMPT`,
   - the exported `stripEmDashes` function, and apply it where the model response text is
     returned (in `post()`: `return out ? stripEmDashes(out) : fallback`).

3. **Whisper determinism.** In `src/main/transcription/whisper.ts`, next to
   `form.append('response_format', 'json')` add:
   ```ts
   form.append('temperature', '0')
   ```

4. **Default cleanup to auto.** In `src/shared/types.ts` `DEFAULT_SETTINGS`, change
   `cleanupMode: 'off'` (or `'on-demand'`) to `cleanupMode: 'auto'`. Also flip your live
   setting: quit Echo (tray), edit `%APPDATA%\echo\settings.json` → `"cleanupMode": "auto"`.

5. **Wire the voice commands** in `src/main/dictation.ts`:
   ```ts
   import { applyVoiceCommands } from '@shared/voice-commands'
   ```
   and where the transcript is dictionary-corrected (search for `this.correct(heard`):
   ```ts
   const raw = applyVoiceCommands(this.correct(heard, dict))
   ```

6. **Verify and ship:**
   ```powershell
   npm test          # all green, including the 9 new voice-commands tests
   npm run typecheck
   npm run pack      # → dist\win-unpacked\Echo.exe
   ```
   Quit Echo from the tray, copy `dist\win-unpacked` over your installed copy
   (e.g. `%LOCALAPPDATA%\Programs\Echo`), and start `Echo.exe` again.

## Sanity check after install

Hold the trigger key and say:
> "um write an email to bryan hey bryan new paragraph the numbers look good leave a space thanks tanay"

You should get a properly formatted email with paragraphs — no "um", no command words.
