# Meeting notes: automatic, private, speaker-labelled meeting transcripts

Status: approved for build, 2026-09-22. Platform: Windows x64 first; macOS shows the feature as
unavailable until a Core Audio process-tap helper exists.

## Problem

Google Meet only delivers its transcript to the organiser, and Slack huddles are never recorded.
The user wants every meeting they attend (Meet, Teams, Slack huddles, Zoom) transcribed on their
own PC, with each line labelled by who said it ("Tanay", "Blake Whitmore"), plus notes they can
trust, without ever recording outside a meeting.

## Non-negotiable behaviour

1. **Record only during a meeting.** Echo records only while an allow-listed meeting app holds
   the microphone *and* shows meeting evidence (a meeting window or tab). A lobby is not a
   meeting. Recording stops within ~15 s of the call ending (as built in T6: ~4 s when the
   meeting is visibly gone, and the audio and transcript are trimmed to the last live moment).
2. **Always visible.** The bottom dictation overlay's capsule shows every meeting state
   (detected, recording with elapsed time, ended, notes ready) and, on hover, the controls
   (Record now / Don't record; Pause my mic, Stop, Discard, Open). The tray says so too. Windows
   notifications are opt-in (`meetingNotifications`, default off). *(As built in T6: the separate
   top-centre pill window from T5 was replaced by the overlay capsule; see "Meeting states in the
   overlay".)*
   Process loopback has no Windows privacy indicator, so Echo's own indicator is the only cue.
3. **Local first.** Audio stays in `userData/meetings/<uuid>/` and on the user's GB10. Speaker
   voiceprints never leave the PC. Transcript excerpts reach Claude (notes) and, only when a
   TypeSafe key is configured, TypeSafe JEV (verification).
4. **Accuracy over speed.** A live transcript appears during the call; a slower final pass
   replaces it after the call with diarized, speaker-named, highest-accuracy text.
5. **Never invent names.** A name is shown only from the user's settings (their own voice), a
   remembered voice above the accept threshold, a single-remote-speaker window-title hint, or (as
   built in T6) the calendar: its only other attendee when one remote person spoke, or an attendee
   the conversation addresses by name. Everything else is "Speaker N" with a one-click suggestion.
6. **Never lose a meeting.** A crash mid-meeting leaves playable PCM; the next launch finalises it.

## Architecture

```
EchoMeetingHelper.exe (C#, net10.0-windows, NAudio 3.1)          GB10 (behind the Bearer shim)
  capture-session watcher ─ mic-sessions ─┐                        /v1/audio/transcriptions (existing)
  probe: windows, browser tabs, render ───┤                        /v1/audio/segments   (NEW, batch)
  record: mic.pcm + others.pcm ───────────┤                        /v1/audio/diarizations (NEW,
                                          ▼                          pyannote community-1 :8004)
Echo main process                                                        ▲
  helper-client ─► meeting-detect (pure) ─► MeetingSession (pure) ─► MeetingController
                                                                    │   │ live: chunk → Parakeet
                                                                    │   │ final: diarize → segments
                                                                    │   │   → Canary + Parakeet → names
                                                                    │   │   → notes (Claude) → JEV
                                                                    ▼   ▼
                                     MeetingsStore / VoiceprintStore (sql.js)   .md in output folder
Dashboard: Meetings page · overlay capsule (meeting states) · Settings › Meetings · tray · opt-in notifications
```

## Detection (helper + `src/shared/meeting-detect.ts` + `src/shared/meeting-session.ts`)

The helper watches ACTIVE capture sessions on every capture endpoint (Core Audio
`IAudioSessionManager2`, MTA, event-driven; `RegNotifyChangeKeyValue` on the
CapabilityAccessManager `microphone` key and a 60 s safety rescan only re-trigger a scan). It
emits `mic-sessions` on change, excluding Echo's own process tree (`--echo-pid`) and itself.

Meeting apps (by `exe` / `packageFamily`):

| App | Mic owner | Meeting evidence (from `probe`) |
| --- | --- | --- |
| Google Meet | chrome.exe, msedge.exe, brave.exe, firefox.exe, arc.exe | A tab named `Meet - <code or title> - Microphone recording` (or `Camera and microphone recording`); else a window/tab title starting `Meet - ` / `Meet – ` that is not `Meet - Google Chrome` (loading) or the `Google Meet` landing page |
| Teams (desktop) | ms-teams.exe (package `MSTeams_8wekyb3d8bbwe`), teams.exe (classic) | Mic alone suffices (Teams only captures in calls). Title `<X> \| Microsoft Teams` other than the always-present `Meet \| Microsoft Teams`, bare `Microsoft Teams`, and `Chat/Activity/Calendar/Teams/Calls/OneDrive/Apps \| …` main-window sections gives the title; `Meeting with <Name>` gives a name hint |
| Teams (web) | browsers | Tab/window title containing `\| Microsoft Teams` with a recording suffix |
| Slack | slack.exe or package `com.tinyspeck.slackdesktop_*`; browsers with a Slack tab + recording suffix | Mic alone (Slack only captures in huddles/clips; the lobby gate below rules out clips). Main title `<Name> (DM) - <workspace> - Slack` (optionally prefixed `! ` or suffixed with counters/emoji) gives a name hint and title; `#channel - …` gives the title |
| Zoom | zoom.exe | A `Zoom Meeting` window (or class `ZPContentViewWndClass`) |
| Webex | ciscocollabhost.exe, webexmta.exe, atmgr.exe, webex.exe | A window whose title contains `Meeting` |

A browser holding the mic with no meeting tab/title (voice notes, ChatGPT voice, …) is **not** a
meeting. `otherPids` = the app's ACTIVE render-session PIDs, else all its render-session PIDs,
else `[appPid]`. `remoteAudio` = any of the app's render sessions has `peak >= 0.003`.

**Session state machine** (`MeetingSession`, one recording at a time):

- `idle` → `pending` when a candidate appears.
- `pending` → `recording` (action `start`) when the candidate has been continuously present for
  `confirmAfterMs` (3 s) **and** remote audio has been heard since it appeared, **or** after
  `aloneConfirmAfterMs` (90 s) of continuous presence without remote audio (you joined first). A
  lobby with no remote audio never starts a recording within 90 s. *(As built in T6: "heard" means
  sustained — remote audio in two probes between `remoteConfirmMinGapMs` (1 s) and
  `remoteConfirmMaxGapMs` (6 s) apart. In the first real interview, Meet's join chime alone had
  started a recording 63 s before the other person joined.)*
- `recording`: `update` when the candidate's title/nameHints change; `retarget` when its
  `otherPids` change. If the candidate disappears, keep recording for `endAfterMs` (15 s); if it
  is still gone, `stop('ended')`. `maxDurationMs` (4 h) → `stop('max-duration')`.
- **Ending promptly** (added during T6): when the probe shows the meeting is definitively gone
  (continuation evidence `false`: no meeting tab or window), the grace is `endWhenGoneMs` (4 s)
  instead of 15 s; an unknown answer (no probe) keeps 15 s. The session tracks `lastLiveAt`, the
  last observation with **actual** evidence: the app held a mic session, or (muted) the far end was
  heard (render peak ≥ threshold, or the meeting tab's "Audio playing"). The continuation window
  itself never counts. On `stop('ended')` the controller truncates both PCM files to
  `lastLiveAt` + one probe interval (2 s: the call ended between that observation and the next),
  ends the live loop there (`endAt`), deletes live segments after it, sets `ended_at` from the
  kept samples, and logs only the trimmed seconds.
- **Audio-only continuation** (Slack): with no huddle window to check, `continuationEvidence`
  marks the evidence `audioOnly`. Such a call continues without a mic session only while the far
  end is heard, and ends `endAfterMs` (15 s) after `lastLiveAt`, not after 60 s + 15 s. A muted
  huddle stays alive while the others talk. (Real huddle, meeting 5: Slack released the mic when the
  huddle ended; the old rule kept recording for 75 s and trimmed only 17 s of it.)
- **Continuation without a mic session** (added during T6): some apps release the mic on mute.
  While recording, the recorded app keeps being probed even with no mic session, and the recording
  stays alive while its meeting evidence persists (browser: the meeting tab by title, any alert
  suffix; Teams/Zoom/Webex: the meeting window; Slack: none, so only remote audio) **and** remote
  audio was heard within `continueWithoutMicMs` (60 s). In a browser, remote audio is the meeting
  tab's own `- Audio playing` alert, or the render meter only when no other tab is the one
  playing. A tab title that lingers after leaving the call therefore ends the recording after
  60 s + the 15 s grace. Unmuting brings back the same candidate key, so no second recording
  starts. (`continuationEvidence` in meeting-detect, `MeetingContinuation` in meeting-session.)
- User Stop/Discard → `stop('user'|'discard')` and **suppress** that candidate key until it
  disappears, so the same call does not restart.
- Disabling meetings in Settings while recording → `stop('disabled')`.

## Capture (helper `record-*`)

Two files, both 16 kHz mono s16le, sample 0 = `startedAt`, always the same length:
`mic.pcm` (the meeting app's own capture endpoint, shared mode, format-converted) and
`others.pcm` (WASAPI process loopback of `otherPids` with `INCLUDE_TARGET_PROCESS_TREE`,
requested directly as 16 kHz mono; multiple PIDs are summed with clipping). The reader runs on an
MMCSS "Audio" thread, pads gaps using QPC timestamps, and flushes to disk at least every second.
If process loopback cannot be activated it falls back to loopback of everything except Echo
(`EXCLUDE_TARGET_PROCESS_TREE` on Echo) and reports `othersMode: 'system'`. A lost mic is
reopened on the new default communications endpoint with the gap zero-padded. If stdin closes
(Echo crashed) the helper finishes the files and exits.

## Mic pause (added during T6)

What the user says while muted must never reach a transcript, notes or an export. Mute state
cannot be read reliably from outside the meeting apps, so:

- Helper request `record-mic-pause {id, paused}` → reply `record-mic-paused {id, paused, samples}`.
  While paused the helper commits digital zeros to `mic.pcm` in place of the mic (the real audio
  never reaches disk); the timeline and both file lengths are unchanged. `samples` is the index the
  state applies from.
- The controller pauses automatically while the recorded app holds no mic session (it muted) and
  resumes when the session returns; the user can pause/resume at any time from the overlay capsule, the tray
  and the Meetings live banner (`LiveMeetingState.micPaused`, `MeetingsApi.setMicPaused`,
  `MEETINGS_IPC.SET_MIC_PAUSED`). A user pause is never lifted automatically; a user resume
  overrides an automatic pause until the app releases the mic again. Every recording starts on.
- Pause spans are kept in `<audio_dir>/mic-pauses.json`. The live loop and the final pass both
  silence each span plus the **1 s before it** (an app's mute is noticed a few hundred ms after the
  click); the live loop also re-sends a queued, in-flight or held chunk that overlaps a pause with
  that part silenced. A pause the helper cannot confirm still counts (clock position).
- Not built: detecting the in-app mute *button* (UI Automation on Teams/Zoom/Meet/Slack).

## Meeting states in the overlay (added during T6)

`LiveMeetingState.phase` is `idle | detected | recording | ended` (plus `ended: saved | discarded`).
The controller shows a pending `MeetingSession` candidate as **detected**, and
`MeetingSession.startNow` backs "Record now". "Don't record" is the existing pending-stop
suppression. A recording that ends shows **saved** for about 4 s (or **discarded** for about 3 s).
After the final pass, a `notice` event (`notes-ready`, `notes-failed` or `record-failed`) shows
for 5 s; it waits for a dictation to end, and clicking it opens the meeting.

The bottom dictation overlay renders these states in its single capsule element
(`src/shared/meeting-capsule.ts` picks the view; a detected capsule settles to a compact amber dot
after 5 s), so the capsule still morphs into a dictation, which always takes priority. The overlay
window is unchanged (460×124, click-through, non-focusable). While the pointer is over the capsule,
`overlay:interactive` turns click-through off, so its buttons work without taking focus.

Windows notifications (detected if still waiting after 3 s without remote audio, recording
started, recording ended, notes ready or failed) are sent only with `meetingNotifications` on.

## Live transcript (`MeetingController` + `src/shared/meeting-audio.ts`)

Every 2 s the controller reads new samples from both files and asks `planLiveCut` for the next
chunk per channel: once ≥ 12 s are pending, cut at the quietest 300 ms window between 8 s and
25 s; force a cut by 30 s; at stop, flush the remainder. Chunks where `speechSeconds` < 0.4 s are
skipped (never sent). Non-silent chunks go to the live model (Parakeet) through the existing
`/audio/transcriptions` route. Mic chunks are labelled `me`; others chunks are labelled
`others`, shown as the single name hint when there is exactly one, else "Others". A mic chunk
whose text is mostly contained in an overlapping others chunk (bleed from speakers) is dropped
(`isBleed`). Live segments are stored with `pass: 'live'` and pushed to the dashboard.

## Final pass (after `stop`)

1. **Diarize** `others.pcm` (`max_speakers` 8) and `mic.pcm` (`max_speakers` 4) via
   `/v1/audio/diarizations`. On the mic channel the speaker with the most speech is `me`; other
   mic speakers are dropped where they overlap others-channel speech (bleed), else kept as
   `mic:<label>` (someone in the room).
   *(Added during T6)* `mergeSpeakers` (`src/shared/meeting-diarization.ts`) then cleans each
   channel: a **minor** speaker (< 20 s, or < 10% of the channel's speech) folds into the closest
   major speaker at centroid cosine ≥ 0.25 (one person's backchannel cluster against their answers
   measured 0.298 and 0.277 on the real interview; different people 0.05–0.20), or into the only
   major speaker when it has no embedding; two **major** speakers merge at cosine ≥ 0.75 when they
   never talk at the same time (< 1 s overlap). With exactly one calendar attendee besides the
   user, every others-channel speaker merges into the main one. Each merge is logged with its
   cosine.
2. **Segment**: `buildAsrSegments` merges same-speaker turns with gaps < 0.8 s, splits anything
   > 30 s at the quietest 300 ms point, pads ±0.2 s (clamped, never into another speaker's turn
   by more than the pad), and folds turns < 0.6 s into an adjacent same-speaker segment or drops
   them if isolated and < 0.3 s.
3. **Decode** segments in batches of ≤ 5 min of audio through `/v1/audio/segments` with models
   `[meetingFinalModel, meetingCheckModel]` (Canary-Qwen + Parakeet). `chooseSegmentText`
   guards against LLM-decoder hallucination (see ticket T3). The user's dictionary aliases are
   applied to every chosen text (`applyDictionary`). *(Added during T6, from the real interview:)*
   a clip with < 0.06 s of speech (a click diarized as a turn) is never sent; on clips < 1.5 s the
   primary is kept only when ≥ 50% of its words are in the check model's text, otherwise the check
   wins, except that a hum from either model ("Mm-hmm", "Mhm") is kept as "Mm-hmm"; filler-only
   texts (um, uh, hmm, mm, er, ah) are dropped, while backchannels (Mm-hmm, Yeah, Okay) stay.
   *(Added during T8)* `meetingVocabModel` (default `granite-speech-4.1-2b`, empty turns it off)
   decodes the same clips in the same request with the meeting's keyword list (`meetingKeywords`:
   the user, attendees, name hints, remembered voices, dictionary words). After `chooseSegmentText`,
   `transplantVocabulary` (`src/shared/vocab-transplant.ts`) swaps in the vocabulary model's word
   only as a one-for-one substitution between aligned words, when that word (or a two-word span) is
   a listed term and sounds like the word it replaces; never a word it inserted, dropped or merged,
   never a function word or contraction. If the request with it fails, the batch is decoded again
   without it and the pass continues without the transplant.
4. **Name speakers** (`nameSpeakers`): `me` → the user's name; others by voiceprint
   (accept ≥ 0.70 and margin ≥ 0.10 over the runner-up; suggest ≥ 0.55; exclusive assignment,
   only speakers with ≥ 5 s) then by hint (exactly one remote speaker with ≥ 10 s + exactly one
   name hint, and no voiceprint says otherwise → `hint`). Everything else "Speaker N" in order
   of first appearance. *(Added during T6)*, in this order:
   - **Calendar** (`src/shared/ics.ts`, `src/main/meetings/calendar.ts`): the meeting's
     participants (attendees and organiser minus the user, declined and resource entries) come
     from the event matched by Meet code in its location/description/URL, else by title and time
     overlap, else the only event at that time with the app's meeting link. One participant + one remote speaker → that speaker is named, source `calendar`
     ("from calendar"). With more, a voiceprint suggestion naming an attendee is accepted.
   - **Name spelling** (`src/shared/name-correction.ts`): known names (user, participants,
     named speakers, and everyone in the voiceprint library, in this meeting or not) replace close phonetic mishearings in the text ("Deren" → "Darin", "Thane" →
     "Tanay"): only capitalised words that are not common English words (or a two-word split
     right after an address word, like "it's dare in"), with the same sound-class key, a bounded
     edit distance and the same leading vowel quality. A surname right after its person's first
     name ("Daren Kudira" → "Darin Kadiro") is fixed without the vowel rule.
   - **Conversation** (`src/main/meetings/speaker-names.ts`): one Claude call proposes names for
     the still-unnamed speakers, citing utterance ids; a proposal is kept only when a cited
     utterance or its neighbour contains the name. An attendee's name names the speaker (source
     `calendar`); any other name is only a suggestion. It never overrides the user, voiceprint,
     hint or calendar names.
5. **Assemble** utterances (`assembleTranscript`): time-ordered, adjacent same-speaker segments
   merged when the gap < 1.5 s, bleed dropped.
6. **Notes**: Claude (`claudeModel`, then `fallbackModel`) returns strict JSON with summary,
   decisions, action items (owner, due) and open questions, each citing utterance ids. Items
   citing unknown ids are dropped in code.
7. **Verify** (only with a TypeSafe key): one JEV request per item with the cited utterances ±2
   neighbours. `supported` keeps it; `insufficient` keeps it flagged; `contradicted`/`unrelated`
   drop it. Failures leave items `unverified`; notes always ship.
8. **Write** the `.md` (notes + transcript) to the output folder, store segments with
   `pass: 'final'` (replacing live ones), notify "Meeting notes ready".

Each step updates `progress`. A failed step marks the meeting `failed` with a reason; live
segments remain and **Reprocess** retries from the retained audio. Exceptions (as built in T6):
a diarizer that is missing or down (404, 5xx, network, timeout, malformed reply) falls back to
pause-cut segments with one speaker per channel instead of failing; a notes or verification
failure still ships the transcript (`notes: null` or unverified items). Per-speaker embeddings for
"remember this voice" are kept in `userData/meetings/<uuid>.speakers.json`, outside the audio
directory, so audio retention does not delete them.

## Speaker names

- The user's own name comes from Settings (`meetingUserName`, default the OS account name).
- Voiceprints: per person, up to 20 exemplars `{embedding (unit 256-d WeSpeaker), model, seconds,
  sourceApp, createdAt}` in the local DB. Exemplars are added only when the user names/confirms a
  speaker with ≥ 10 s of speech ("remember this voice") or on a voiceprint auto-match ≥ 0.75
  with margin. Embeddings from a different `embeddingModel` are never compared.
- Renaming a speaker in the UI relabels that meeting's transcript and, with "remember", enrols
  the voice. "Forget" deletes every exemplar.

## GB10 routes (`gb10/`)

- `gb10/diarizer/server.py` on `127.0.0.1:8004` in its own venv (`~/diar`), pyannote.audio 4.x
  `speaker-diarization-community-1` loaded offline from a local copy, telemetry off
  (`PYANNOTE_METRICS_ENABLED=0`), stateless, logs timings only.
- Shim `POST /v1/audio/diarizations` (multipart `file`, optional `num_speakers`,
  `min_speakers`, `max_speakers`, `embeddings`) → `{duration, model, embedding_model,
  embedding_dim, segments:[{start,end,speaker}], speakers:[{id, speech_seconds, turns,
  embedding}]}`.
- Shim `POST /v1/audio/segments` (multipart `file` = 16 kHz mono WAV, `models` = comma list,
  `segments` = JSON `[{id,start,end}]` in seconds) → `{results:[{id, texts:{model:text}}]}`.
  The shim slices the WAV and forwards each slice to the existing model routes one at a time per
  model (models in parallel), so live dictation interleaves instead of queueing behind a batch.
- `/v1/audio/transcriptions` is unchanged.

## Storage

`history.sqlite` gains `meetings`, `meeting_segments`, `people`, `voiceprints` tables (not
synced). Audio and the helper's PCM live in `userData/meetings/<uuid>/`. After the final pass the
PCM is kept for `meetingRetainAudioDays` (default 30; 0 deletes right after notes are ready) and
pruned on launch and daily. The `.md` goes to `meetingOutputDir` (default `Documents\Echo
Meetings`), named `YYYY-MM-DD HHmm <App> - <title>.md`.

## Calendar (added during T6)

Secret `calendarIcsUrl` (encrypted, shown masked as the host only; seedable), setting
`meetingMyEmail` (optional, excludes the user from attendees; the user's name also does). The ICS
is fetched at most every 10 minutes, and when a meeting starts (at most once a minute when forced);
`webcal://` becomes `https://`. The parser handles folding, TZID (IANA and Windows zone names),
all-day events, RRULE (daily/weekly/monthly/yearly with INTERVAL, COUNT, UNTIL, BYDAY), EXDATE,
RECURRENCE-ID overrides and cancellations. Participants found at start are stored on the meeting
(`participants` column); the final pass re-reads the calendar when there are none. The URL never
reaches logs; failures log the error kind only. Settings › Calendar has the address, "My calendar
email" and a Test button (today's event count).

## Settings (Settings › Meetings)

`meetingMode` ('auto' | 'off', default 'auto' on Windows, 'off' elsewhere), `meetingApps`
(per-app toggles, all on), `meetingUserName`, `meetingOutputDir`, `meetingRetainAudioDays`,
`meetingLiveModel` (`parakeet-tdt-0.6b-v2`), `meetingFinalModel` (`canary-qwen-2.5b`),
`meetingCheckModel` (`parakeet-tdt-0.6b-v2`), `meetingNotes` (true), `meetingVerifyNotes` (true).
Secret `typesafeApiKey` (seedable from `secrets.local.json`). The section notes that recording
laws vary and participants should be told.

## Rejected alternatives

- **Electron `getDisplayMedia` loopback** for the others channel: it captures only the default
  render device (meeting apps often use the communications device) and every app's audio.
- **Registry `LastUsedTimeStop` as the primary detector**: undocumented, no PIDs, stale after
  crashes. It is only a re-scan trigger.
- **Reading participant names through UI Automation / captions**: web-content accessibility is
  off by default, costly, and breaks with every UI change. Deferred.
- **Streaming diarization for the live view**: Sortformer caps at 4 speakers and returns no
  embeddings; the final pass fixes speakers.
- **JEV for speaker naming**: it missed obvious cues in testing. Voiceprints, titles and the
  calendar name speakers; a Claude pass over the conversation only suggests names, each backed by
  an utterance that says it.

## Ticket graph

| Ticket | Scope | Depends on |
| --- | --- | --- |
| T1 | Windows meeting helper (C#) + TS helper client + build wiring | contracts |
| T2 | GB10 diarizer + shim routes + deploy + TS speech client | contracts |
| T3 | Pure logic: detect, session machine, audio chunking, segments, text choice, bleed, naming, transcript, export | contracts |
| T4 | Stores (meetings, voiceprints) + Claude notes + JEV verifier | contracts |
| T5 | Dashboard, meeting pill, settings/secrets, preload, types | contracts |
| T6 | MeetingController, IPC, tray, notifications, recovery, retention, end-to-end check | T1–T5 |
