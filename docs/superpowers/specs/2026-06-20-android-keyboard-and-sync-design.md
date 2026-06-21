# Echo — Android voice keyboard + cross-device sync

**Date:** 2026-06-20
**Status:** Draft — decisions made on the user's behalf (per "build it, don't ask
questions"); build in progress. Read this and interject anytime.

## 1. Goal

Dictate into **any** Android app with the same Whisper accuracy as desktop Echo,
triggered by an always-available control, showing the desktop-style status pill.
**History and dictionary sync bidirectionally** across Android ⇄ desktop: dictate on
the phone, it shows up on the desktop and vice-versa; corrections taught on one device
help the other.

## 2. Non-goals (YAGNI)

- **Not a full QWERTY keyboard.** The IME is dictation-only; the user switches back to
  their normal keyboard to type by hand.
- **No accounts / multi-user.** Single user, personal devices, shared-token auth on the
  tailnet.
- **No live partial transcription.** Press → speak → stop → insert (matches desktop).
- **No audio-blob sync.** Only text transcripts + dictionary sync. Audio retention
  stays desktop-local.
- **iOS out of scope.**

## 3. Constraints & context

- **Build env:** the dev workspace (Windows) has no Android toolchain (`adb`/`gradle`/
  `java`/Android Studio all absent). The Android app is **authored here, built &
  installed by the user** via Android Studio. All TypeScript (service + desktop) is
  built and unit-tested here.
- **Sync home:** a small self-hosted service on the user's **tailnet Mac Mini**,
  alongside the existing Whisper/Claude proxy. No cloud accounts, zero marginal cost.
- **Accuracy stack reused on Android:** the Whisper endpoint contract
  (`src/main/transcription/whisper.ts`), WAV encoding (`src/shared/wav.ts`), and
  dictionary apply + bias prompt (`src/shared/dictionary.ts`).
- **Existing stores:** a single sql.js DB (`history.sqlite`) holding `transcripts` +
  `dictionary`, both with `INTEGER PRIMARY KEY AUTOINCREMENT`, sharing one debounced
  `onChange()` persist hook (`src/main/store/history-file.ts:39`).

## 4. Architecture

Three subsystems joined by one sync contract:

```
   Android IME app (Kotlin)                Desktop Echo (Electron/TS)
   AudioRecord → WAV → Whisper             existing dictation cycle
   commitText() into any field             HistoryStore / DictionaryStore
   Room (local SQLite)                     sql.js (local)
            \                                       /
             \___ sync client ___          ___ sync client (onChange hook)
                               \          /
                          Sync service (Node/TS — tailnet Mac Mini)
                          SQLite-backed · REST · bearer-token auth
                          last-write-wins + tombstones · seq cursor
```

## 5. Sync data model & protocol (the shared contract)

Each syncable row gains a **sync identity**:

- `uuid: string` — device-independent identity, generated at row creation. (The existing
  autoincrement `id` stays as the *local* primary key.)
- `updated_at: number` — epoch ms of last local change; the **last-write-wins** key.
- `deleted: boolean` (0/1) — **tombstone** so deletes propagate.

The server additionally assigns:

- `seq: number` — monotonic per-collection sequence, assigned on write. This is the
  **pull cursor** — clock-independent, so it never loses an update to clock skew.

Collections: `transcripts`, `dictionary`.

**Wire format** (shared TS types in `src/shared/sync.ts`, ported to Kotlin/service):

- `SyncEnvelope<T>` = `{ uuid, updatedAt, deleted, payload: T | null }` (payload null on
  tombstone)
- `StoredRecord<T>` = `SyncEnvelope<T> & { seq }`
- **Pull:** `GET /sync/:collection?since=<cursor>&limit=N` → `{ records: StoredRecord[],
  cursor, hasMore }`
- **Push:** `POST /sync/:collection { records: SyncEnvelope[] }` → `{ applied }` (count
  only — clients advance their pull cursor *exclusively* from pull responses; a push-side
  seq is unsafe as a pull cursor because it would skip records other devices wrote at
  intervening seqs. Re-pulling one's own writes is harmless: the merge is LWW-idempotent.)
- **Auth:** `Authorization: Bearer <syncToken>`

**Merge semantics** (pure, in `src/shared/sync.ts`, TDD'd — the heart of correctness):

- `shouldApply(local, incoming)` → apply iff `local` is null **or**
  `incoming.updatedAt > local.updatedAt`. Equal ⇒ skip (idempotent). Deletes are normal
  records (`deleted=true` with a bumped `updatedAt`) and win by recency like anything
  else.
- `advanceCursor(current, batch)` → `max(current, max(seq in batch))`.

**Client sync loop** (identical on both platforms): pull since cursor → merge each via
`shouldApply` → push local rows changed since `lastPushAt` → persist new cursor.
Triggered on local change (debounced), on keyboard-open / app-focus, and periodically.

## 6. Subsystem A — Android voice keyboard (IME)

- **`InputMethodService`** (`EchoImeService`) with a compact input view: a large mic
  button, a status pill mirroring `DictationPhase`
  (`listening → transcribing → inserted | empty | error`), and a globe button to switch
  back to the normal keyboard.
- **Capture:** `AudioRecord`, 16 kHz mono PCM16 (Whisper-native; mirrors
  `TARGET_RATE = 16000` in `wav.ts`) → build a WAV in memory (port `floatToWav`).
- **Transcribe:** multipart POST to `{whisperBaseUrl}/audio/transcriptions` with the
  Bearer key, `model`, `response_format=json`, and `prompt = buildBiasPrompt(dictionary)`
  — mirroring `whisper.ts` including its retry/timeout behavior.
- **Correct:** port `applyDictionary` for deterministic replacements; bump
  `times_applied` locally.
- **Optional cleanup:** if enabled, POST to the Claude proxy (port `claude.ts`). **Off by
  default** to keep latency low.
- **Insert:** `currentInputConnection.commitText(text, 1)`.
- **Persist + sync:** write the transcript to Room, enqueue a sync push; pull the
  dictionary so the bias prompt stays current.
- **Config Activity:** `whisperBaseUrl` / key / model, optional Claude, `syncBaseUrl` /
  token — stored in `EncryptedSharedPreferences`.
- **Permissions:** `RECORD_AUDIO` (runtime), `INTERNET`. User enables the keyboard + grants mic once.
- **Trigger reality:** the mic lives on the Echo keyboard ("always at the bottom"). Add
  Echo as a secondary keyboard; tap the globe to switch to it to dictate, globe back to
  type. This is the robust, permission-free match to the requested "button at the
  bottom."

## 7. Subsystem B — Sync service (Node/TS, Mac Mini)

- Tiny HTTP service, **SQLite-backed** (`better-sqlite3`), one table per collection:
  `(uuid PK, updated_at, deleted, payload JSON, seq INTEGER monotonic)`.
- Endpoints: `GET`/`POST /sync/:collection` (§5) + `GET /health`.
- **Auth:** shared bearer token from env; bind to the tailnet interface only.
- **LWW upsert** on POST using the same `shouldApply` rule (shared module).
- **Deploy:** a small process runner (launchd plist / pm2) on the Mac Mini — documented
  in the build guide.

## 8. Subsystem C — Desktop integration

- **Schema migration:** add `uuid` / `updated_at` / `deleted` to `transcripts` +
  `dictionary`; on first run backfill `uuid` and set `updated_at = created_at`. Keep the
  autoincrement `id` as local pk.
- **Stamp on write:** set `uuid` + `updated_at` on insert/update; **delete becomes a
  soft-delete** (`deleted=1`, bump `updated_at`). All reads filter `deleted=0`.
- **Sync client** (`src/main/sync/…`): pull/push against the service; persist `cursor` +
  `lastPushAt` in userData; trigger from the existing `onChange` hook (debounced) + on
  app start + on an interval.
- **Settings:** `syncBaseUrl` + `syncToken`, seedable via `secrets.local.json` exactly
  like the Whisper key.
- **Tests:** migration + backfill, soft-delete filtering, sync client pull/push/merge
  with mocked `fetch` (mirrors the existing `whisper.test` style).

## 9. Risks & decisions

- **Clock skew vs LWW:** acceptable for personal 2–3 device use; the `seq` cursor
  prevents *lost* updates, and genuine concurrent edits resolve last-writer-wins. Noted,
  not engineered around.
- **IME over Accessibility/floating button:** chosen for reliability and zero sensitive
  permissions (decided in brainstorming). `commitText` is the same path Gboard uses.
- **Injection edge cases** (password fields, exotic custom editors): inherent to any
  keyboard; acceptable.
- **Security:** shared token + tailnet-only binding; the token lives in the gitignored
  `secrets.local.json` and is never committed.
- **Android build burden on the user:** mitigated with a precise, copy-paste Android
  Studio guide; the app is small and single-purpose.

## 10. Build sequence

1. **Sync foundation** — `src/shared/sync.ts` + tests *(in progress)*.
2. **Sync service** + **desktop integration** (schema migration, sync client, settings)
   with tests.
3. **Android IME app** + a dead-simple build/install guide.
