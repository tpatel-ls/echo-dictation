# Echo — Android keyboard + cross-device sync · BUILD HANDOFF

**Paste this whole file as the first message of a new session to resume the build.**
You are resuming a multi-task build that is already ~half done. Continue from **Task 7**
and do not stop until **Task 13** is complete.

Branch: `feat/android-ime-sync` (all work below is uncommitted in the working tree).
Full design spec: `docs/superpowers/specs/2026-06-20-android-keyboard-and-sync-design.md`.

---

## 1. What we're building

Tanay dictates on Windows desktop **Echo** (Electron/TS push-to-talk: hold Right Ctrl →
Whisper transcription pasted into the focused app). He wants the same on **Android**, in
*any* app, plus **history + dictionary sync** across desktop ⇄ phone.

Three subsystems:
1. **Sync service** — tiny self-hosted Node/TS REST service (runs on his tailnet Mac Mini).
2. **Desktop integration** — Echo's stores stamp sync metadata; a sync client push/pulls.
3. **Android voice keyboard (IME)** — native Kotlin; mic key types Whisper text into any app.

Why a native Kotlin IME (not Electron/PWA): only a native keyboard/AccessibilityService can
type into *other* Android apps. Electron can't run on Android; a PWA can't reach outside its
sandbox. This was settled with the user.

---

## 2. Environment & hard constraints

- **No Android toolchain on this machine** (no JDK/Gradle/SDK/Android Studio — verified).
  → The Kotlin app is **authored here but compiled/installed by the user**. Its pure logic
  gets JUnit tests that mirror the (passing) TS tests, but they run on his machine. Never
  claim the Android app "runs" or quote latency — you can't execute it here.
- **Sync home** = the user's tailnet Mac Mini (self-hosted, zero cloud). Keep endpoints as
  placeholders; `secrets.local.json` is gitignored — never commit tokens/tailnet hostnames.
- **Platform**: Windows, PowerShell primary. Bash tool available.

### Verify commands (baseline: all green right now)
- `npm test` → **178 passing** (Vitest, `tests/*.test.ts`)
- `npm run typecheck` → clean (node + web tsconfig)
- `npm run build` → clean (electron-vite bundles)
- Sync service: `SYNC_TOKEN=xxx npm run sync-server` (needs `npm install` for the `tsx` dep)

---

## 3. Process rules (follow exactly — this is how the user wants it)

For **every** task, in order, no skipping:
1. **TDD**: write the failing test first, run it, watch it fail (RED) for the right reason,
   then write minimal code to pass (GREEN). Tests live in `tests/`, mirror existing style
   (vitest, in-memory `sql.js`, mocked `fetch`). CLAUDE.md mandates TDD for pure logic in
   `src/shared/`, stores, and clients.
2. **Verify**: `npm test` + `npm run typecheck` both green before moving on.
3. **Review**: run a `/code-review`-style pass on the task's diff — dispatch 1–2 subagents
   (one correctness/recall, one cleanup/conventions) over the changed files. Ask them for
   concrete `{file,line,summary,failure_scenario}` findings.
4. **Fix every real finding**, re-verify (RED→GREEN for bug fixes), and explicitly note any
   finding you decline and why. Don't mark a task done with failing tests or unaddressed bugs.
5. **Then** the next task. **Do not stop until all tasks are done.**

Conventions (from `CLAUDE.md` + session memory):
- **No Claude attribution in git** — no `Co-Authored-By: Claude`, no "Generated with" footers.
- Commits authored by the repo owner; use the **tpatel-ls noreply email** (not the gmail) so
  they count on the contribution graph. Only commit/push when the user asks.
- Never push the local-only `private-history` branch.
- `${table}`/`${column}` SQL interpolation is OK **only** for internal constants (never user
  input) — established pattern in `history.ts`.

---

## 4. DONE so far (Tasks 1–6) — verified green

### Sync foundation & service (Tasks 1–3) — `src/shared/`, `src/server/`
- `src/shared/sync.ts` — `shouldApply(local, incoming)` (LWW: apply iff no local or
  `incoming.updatedAt > local.updatedAt`) and `advanceCursor(current, batch)`. The single
  source of truth for conflict resolution, shared by desktop + service (+ the Kotlin port).
- `src/server/sync-store.ts` — `SyncStore` over sql.js. One `records` table keyed by
  `(collection, uuid)` with `updated_at`, `deleted`, opaque `payload` JSON, and a
  **per-collection monotonic `seq`** (the pull cursor). `upsert` (LWW), `since(collection,
  cursor, limit)` (paginated, floors limit≥1).
- `src/server/http.ts` — pure `handleSyncRequest(store, token, req)` + `createServer`
  (Node `http`). `GET /health` (no auth), `GET /sync/:collection?since=&limit=`,
  `POST /sync/:collection {records}` → `{applied}` (push returns a count, **not** a cursor —
  clients advance pull cursor only from GET). Bearer-token auth; validates the envelope;
  body-size cap with stream destroy; 404 on bad collection; rejects non-finite `updatedAt`.
- `src/server/db.ts` — `openSyncDb` with atomic (tmp+rename) debounced persistence,
  **corrupt-DB self-heal** (moves a bad file aside, starts fresh), `unref`'d timer.
- `src/server/index.ts` — entry: env config (`SYNC_TOKEN` required, `SYNC_PORT`/`HOST`/`DB`),
  port validation, double-signal-safe shutdown.
- `src/server/README.md` — run + macOS launchd deploy guide (npm path is arch-aware).
- Tests: `tests/sync.test.ts`, `sync-store.test.ts`, `sync-http.test.ts`, `sync-db.test.ts`.

### Desktop store integration (Tasks 4–6) — `src/main/store/`, `src/main/sync/`
- `src/main/store/migrate.ts` — `ensureSyncColumns(db, table)`: idempotently ALTERs in
  `uuid`/`updated_at`/`deleted`, backfills pre-sync rows with a uuid and **strictly-increasing**
  `updated_at` (created_at order; ties broken so no two rows collide). Runs on every store open
  (self-heals missing uuids).
- `src/main/store/clock.ts` — `monotonicClock(timeSource?)`: never repeats a value. This is the
  **default clock** for both stores. Critical: it guarantees unique `updated_at`, so the push
  watermark's strict `>` can never strand a same-millisecond write.
- `src/main/store/history.ts` & `dictionary.ts` — constructors now take `now = monotonicClock()`;
  insert/add stamp `uuid`+`updated_at`; updates bump `updated_at`; **`delete()` is a soft-delete**
  (`deleted=1` tombstone); all reads filter `deleted=0`. Dictionary **dropped its unique word
  index** (it would wedge cross-device sync when two devices add the same word; uniqueness stays
  enforced at the app level in `add()`).
- `src/main/sync/sync-table.ts` — generic `SyncTable(db, table, dataColumns)`:
  `changedSince(watermark)` (local rows to push, incl. tombstones) and `applyRemote(rec)` (LWW
  upsert by uuid). `SYNC_COLUMNS` = the content columns per collection (**excludes** local `id`
  and `audio_path` — audio is never synced).
- `src/main/sync/client.ts` — `SyncClient.syncOnce()`: per collection, pull (GET since cursor →
  `applyRemote` each, **per-record try/catch so a malformed peer record is skipped not fatal**,
  cursor persisted per page) then push (`changedSince` → POST, advance watermark to max pushed
  `updatedAt`). Per-binding isolation (one collection failing doesn't starve the other).
  Exports `MemorySyncState` + the `SyncState` interface (getCursor/setCursor/getWatermark/
  setWatermark per collection).
- Tests: `tests/clock.test.ts`, `migrate.test.ts`, `sync-table.test.ts`, `sync-client.test.ts`
  (the client test runs against the **real** server handler in-process — proves bidirectional
  sync, delete-propagation, idempotency, poison-pill skip, and the same-ms no-strand fix).

### Key decisions already locked (don't re-litigate)
- Identity = `uuid`; conflict resolution = LWW on `updated_at` via `shouldApply`.
- Pull cursor = server `seq` (clock-independent); push watermark = local `updated_at`
  (safe because of the monotonic clock).
- Tombstones (soft-delete) propagate deletes. Audio never syncs. Dictionary word-uniqueness
  is app-level only.
- Push payload always carries the row's data (even for tombstones) → `applyRemote` never hits
  a NOT NULL issue on its own round-trip.

---

## 5. TO DO (Tasks 7–13)

### Task 7 — Wire sync into the desktop app lifecycle + settings
Testable parts (TDD these), then Electron wiring (author carefully — not unit-testable):
- **`src/main/sync/state.ts` — `FileSyncState implements SyncState`**: persists cursors +
  watermarks to a JSON file in `app.getPath('userData')` (atomic write like `history-file.ts`).
  TDD with a temp file (see `tests/sync-db.test.ts` for the temp-dir pattern).
- **Settings/secrets**: add `syncBaseUrl: string` to `Settings`/`DEFAULT_SETTINGS` and
  `syncToken: string` to `Secrets`/`EMPTY_SECRETS` in `src/shared/types.ts`. Wire into
  `src/main/store/settings.ts` (`getMaskedSecrets`, `setSecrets`) and the seed in
  `src/main/store/seed.ts` (so `secrets.local.json` can pre-fill them like the Whisper key).
  Update `tests/seed.test.ts`.
- **Construct + trigger** (in `src/main/index.ts` / wherever `openHistory` is wired): build the
  two `SyncTable`s over the shared db + a `SyncClient` with `FileSyncState`. Trigger `syncOnce()`
  (a) on app start, (b) from the stores' debounced `onChange` hook (already in
  `history-file.ts:39` — reuse it), (c) on an interval (e.g. 30–60s). Guard against overlapping
  runs and swallow/log transient errors so sync never crashes the app.
- **Settings UI**: add a "Sync" section to the dashboard settings renderer (mirror the existing
  endpoint/key fields — `src/renderer/dashboard/...`) for `syncBaseUrl` + `syncToken`. Add IPC
  if needed (`src/shared/types.ts` `IPC` + `src/main/ipc.ts` + `src/preload/index.ts`).
- Review + fix + verify. Then Task 8.

### Tasks 8–13 — Android voice keyboard (Kotlin; AUTHORED here, built by the user)
Author under a new `android/` directory. **Goal qualities the user stressed**: super simple
setup, always works, super low latency, extremely accurate. Achieve them by:
- **Accuracy** = identical stack to desktop: same Whisper endpoint contract (port
  `src/main/transcription/whisper.ts` incl. retry/timeout), same `buildBiasPrompt` + deterministic
  `applyDictionary` (port `src/shared/dictionary.ts`), same dictionary (synced).
- **Latency** = pre-warmed `AudioRecord` (mic open before the tap), 16 kHz mono PCM16 (smallest
  Whisper payload — mirror `src/shared/wav.ts` `floatToWav`/`TARGET_RATE`), kept-alive HTTP,
  insert-on-stop. No live partials.
- For every pure-logic port, write **JUnit tests mirroring the TS tests** (WAV bytes, dictionary
  apply/bias, `shouldApply`/`advanceCursor`, Whisper JSON parse). State clearly they're authored
  but run on the user's machine.

- **Task 8 — Gradle scaffold + manifest**: `android/` project (Kotlin), `AndroidManifest` with
  the IME service + a config Activity + `RECORD_AUDIO`/`INTERNET`, `method.xml`. (No compile here.)
- **Task 9 — Core pipeline**: `AudioRecord` capture → WAV encoder (port `wav.ts`) → Whisper client
  (port `whisper.ts`) → dictionary apply + bias (port `dictionary.ts`). JUnit tests for the pure bits.
- **Task 10 — Local store (Room) + Kotlin sync client**: Room entities/DAOs for transcripts +
  dictionary with the sync columns; a Kotlin `SyncTable`/`SyncClient` mirroring
  `src/main/sync/*` and `shouldApply`/`advanceCursor` **exactly** (this is why the TS reference
  was built + tested first). Pulls/pushes against the tailnet sync service.
- **Task 11 — IME service + keyboard view**: `EchoImeService : InputMethodService` with a compact
  view — big mic button, status pill mirroring `DictationPhase` (listening/transcribing/inserted/
  empty/error), globe to switch keyboards; `currentInputConnection.commitText()` into the focused
  field. Persist transcript to Room + enqueue a sync push.
- **Task 12 — Settings screen**: config Activity for Whisper base/key/model, optional Claude,
  `syncBaseUrl`/`syncToken`; `EncryptedSharedPreferences`; prompt to enable the keyboard + grant mic.
- **Task 13 — Build & install guide**: one-page `docs/` guide — install Android Studio, open
  `android/`, set endpoints, build a debug APK, sideload, enable the Echo keyboard, grant mic,
  point at the tailnet Whisper + sync endpoints. Copy-paste exact steps. Seeded defaults so first
  run works.

---

## 6. Quick technical reference

**Wire format** (server is payload-agnostic):
- Pull `GET /sync/:collection?since=<seq>&limit=<n>` → `{records:[{uuid,updatedAt,deleted,
  payload,seq}], cursor, hasMore}`.
- Push `POST /sync/:collection {records:[{uuid,updatedAt,deleted,payload}]}` → `{applied}`.
- `payload` = `JSON.stringify(dataColumns)`. `:collection` ∈ {`transcripts`,`dictionary`}.

**Sync columns** (`SYNC_COLUMNS` in `sync-table.ts`):
- transcripts: created_at, raw_text, cleaned_text, duration_ms, word_count, latency_ms,
  app_context, model, status  (NOT id, NOT audio_path)
- dictionary: word, misheard (JSON string), source, created_at, times_applied

**Merge rule** (everywhere): `shouldApply(local, incoming)` = `!local || incoming.updatedAt >
local.updatedAt`. Tombstone = a normal record with `deleted=true` + bumped `updatedAt`.

When resuming: run `npm test && npm run typecheck` first to confirm the 178-test baseline, read
the design spec, then start Task 7. Keep going through Task 13.
