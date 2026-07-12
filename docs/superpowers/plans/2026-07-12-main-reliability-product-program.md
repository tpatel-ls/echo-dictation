# Main Reliability and Product Improvement Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely promote Echo's complete cross-platform branch to `main`, then land exactly 30 tested improvement commits: 20 reliability/security/CI/release improvements and 10 user-facing product improvements.

**Architecture:** Preserve branch history with a normal merge, keep pure policy in testable TypeScript/Kotlin modules, keep Electron and Android platform effects at their existing IPC/activity boundaries, and make every improvement independently reviewable. The program introduces no large runtime dependency and does not change existing sync wire formats.

**Tech Stack:** Electron 42, TypeScript 5.9, React 18, Vitest 4, sql.js, Node.js 20+, Swift, .NET 8 C#, Kotlin/JDK 17, Android SDK 34, GitHub Actions.

## Global Constraints

- Use a normal merge into `main`; never force-push or rewrite `main`, `mac`, or `private-history`.
- The merge and planning commits do not count toward the 30 improvement commits.
- Each numbered task below produces exactly one substantive commit.
- Use TDD for pure logic, stores, clients, parsers, and state machines.
- Never commit `secrets.local.json`, `android/defaults.local.properties`, databases, audio, APK/DMG/EXE artifacts, personal endpoints, or credentials.
- Keep the trigger listener event-driven and keep final network transcription latency claims separate from the less-than-50-ms warm UI response target.
- Preserve desktop/Android sync wire compatibility and existing user data.

---

### Task 0: Merge and Push the Cross-Platform Baseline

**Files:** Resolve only files reported by Git during merge.

**Interfaces:** Produces a verified `main` containing both `a61a8b3` and `1120060` histories.

- [ ] Fetch `origin`, verify a clean worktree, and record `origin/main` and `origin/mac` SHAs.
- [ ] Switch to `main` and run `git merge --no-ff mac -m "merge: promote cross-platform release to main"`.
- [ ] Resolve conflicts by preserving current `mac` behavior while checking `a61a8b3` for unique Willow code.
- [ ] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Push `main` and confirm `git ls-remote origin refs/heads/main` matches local `HEAD`.

---

### Task 1: Desktop CI Matrix

**Files:** Create `.github/workflows/desktop-ci.yml`.

**Interfaces:** Pull requests and pushes to `main` run desktop tests/typechecks plus macOS and Windows production builds.

- [ ] Add a failing repository-structure assertion to `tests/repository-policy.test.ts` requiring the workflow and its three jobs.
- [ ] Run `npx vitest run tests/repository-policy.test.ts`; expect missing workflow failure.
- [ ] Add Ubuntu `test`, macOS `build-mac`, and Windows `build-win` jobs using `actions/checkout@v4`, `actions/setup-node@v4`, npm cache, and concurrency cancellation.
- [ ] Re-run the focused test and `npm test`.
- [ ] Commit: `ci: add desktop verification matrix`.

### Task 2: Android CI Pipeline

**Files:** Create `.github/workflows/android-ci.yml`; modify `tests/repository-policy.test.ts`.

**Interfaces:** Runs `testDebugUnitTest lintDebug assembleDebug` with JDK 17 and uploads APK/lint artifacts.

- [ ] Extend the policy test to require Android SDK 34, JDK 17, Gradle caching, and artifact upload.
- [ ] Run the test and observe failure.
- [ ] Implement the workflow with `gradle/actions/setup-gradle@v4` and `actions/upload-artifact@v4`.
- [ ] Re-run focused tests and validate YAML parsing through the policy test.
- [ ] Commit: `ci: verify Android tests lint and apk`.

### Task 3: CodeQL Security Analysis

**Files:** Create `.github/workflows/codeql.yml`; modify `tests/repository-policy.test.ts`.

**Interfaces:** Analyzes JavaScript/TypeScript and Java/Kotlin on pull requests, `main`, and a weekly schedule.

- [ ] Add policy expectations for both languages and `security-events: write`.
- [ ] Verify RED.
- [ ] Implement `github/codeql-action/init@v3` and `analyze@v3` matrix jobs.
- [ ] Verify GREEN and run the full desktop suite.
- [ ] Commit: `ci: add CodeQL analysis`.

### Task 4: Dependabot Configuration

**Files:** Create `.github/dependabot.yml`; modify `tests/repository-policy.test.ts`.

**Interfaces:** Weekly grouped minor/patch updates for npm, Gradle, and GitHub Actions; majors remain separate.

- [ ] Add policy tests for all three ecosystems and grouped non-major updates.
- [ ] Verify RED.
- [ ] Add the Dependabot configuration with a limit of five open PRs per ecosystem.
- [ ] Verify GREEN.
- [ ] Commit: `chore: configure dependency updates`.

### Task 5: Tracked-Secret Detection

**Files:** Create `scripts/check-tracked-secrets.mjs`; create `tests/secret-scan.test.ts`; modify `package.json` and desktop CI.

**Interfaces:** `scanTrackedFiles(files: Array<{path:string; content:string}>): Finding[]`; `npm run check:secrets` exits nonzero on findings.

- [ ] Test forbidden seed paths, key prefixes, private `.ts.net` hosts, binary artifacts, and safe placeholders.
- [ ] Verify RED because the scanner is missing.
- [ ] Implement pure pattern classification and a CLI that reads only `git ls-files -z`.
- [ ] Add the npm script and CI step; verify focused tests and run the scanner.
- [ ] Commit: `security: block tracked credentials and artifacts`.

### Task 6: Release Artifact Verification

**Files:** Create `src/shared/release-artifacts.ts`, `scripts/verify-release.mjs`, `tests/release-artifacts.test.ts`; modify `package.json`.

**Interfaces:** `classifyArtifact(path, fileOutput): ArtifactKind`; `validateArtifactSet(records): string[]`; CLI writes `dist/SHA256SUMS`.

- [ ] Test required names, Windows x64 PE consistency, macOS arm64 bundle expectations, Android APK presence, and missing/mismatched failures.
- [ ] Verify RED.
- [ ] Implement pure classification plus shell adapter for `file`, `codesign`, and SHA-256.
- [ ] Add `verify:release`; run focused tests against fixture records.
- [ ] Commit: `build: verify release artifact architecture`.

### Task 7: Unified Quality Gates

**Files:** Modify `package.json`, `README.md`, `CLAUDE.md`, desktop and Android workflows; modify `tests/package-scripts.test.ts`.

**Interfaces:** `npm run check`, `npm run check:desktop`, `npm run check:android` are canonical commands.

- [ ] Test exact script presence and that CI calls the canonical scripts.
- [ ] Verify RED.
- [ ] Add scripts with desktop tests/typecheck/build and Android tests/lint; update contributor command docs.
- [ ] Run `npm run check:desktop`.
- [ ] Commit: `chore: unify project quality gates`.

### Task 8: Toolchain Metadata Enforcement

**Files:** Create `src/shared/toolchain.ts`, `scripts/check-toolchain.mjs`, `tests/toolchain.test.ts`; modify `package.json`, `README.md`.

**Interfaces:** `checkToolchain(actual, required): ToolchainIssue[]`; package declares `engines` and `packageManager`.

- [ ] Test accepted Node 20/22, rejected Node 18, accepted npm 10/11, and actionable messages.
- [ ] Verify RED.
- [ ] Implement version parsing without a dependency and wire `preinstall` to the CLI.
- [ ] Verify focused tests using injected versions, then run the real preflight.
- [ ] Commit: `chore: enforce supported toolchains`.

### Task 9: Security Policy

**Files:** Create `SECURITY.md`; modify `tests/repository-policy.test.ts`.

**Interfaces:** Public policy states supported versions, private disclosure route, data boundaries, and credential response.

- [ ] Add policy assertions for disclosure, supported versions, local data, audio, credentials, and response timeline.
- [ ] Verify RED.
- [ ] Write the policy without publishing a personal secret or endpoint.
- [ ] Verify GREEN and run secret scan.
- [ ] Commit: `docs: add security policy`.

### Task 10: Contribution and Pull-Request Standards

**Files:** Create `CONTRIBUTING.md`, `.github/pull_request_template.md`; modify `tests/repository-policy.test.ts`.

**Interfaces:** Defines TDD, platform gates, commit conventions, no-attribution rule, and secret/artifact checklist.

- [ ] Add content assertions for every required contributor check.
- [ ] Verify RED.
- [ ] Write the guide and PR template with copy-paste commands.
- [ ] Verify GREEN.
- [ ] Commit: `docs: define contribution and review standards`.

### Task 11: Atomic Settings Persistence

**Files:** Create `src/main/store/atomic-file.ts`; create `tests/atomic-file.test.ts`; modify `src/main/store/settings.ts`.

**Interfaces:** `writeFileAtomic(path: string, data: string, options?: {mode?: number}): void`.

- [ ] Test same-directory temp creation, rename replacement, mode forwarding, and cleanup after injected failure.
- [ ] Verify RED.
- [ ] Implement with injectable fs operations and use it for settings writes.
- [ ] Run focused settings/atomic tests.
- [ ] Commit: `fix: persist settings atomically`.

### Task 12: Corrupt Settings Recovery

**Files:** Create `src/main/store/settings-file.ts`; create `tests/settings-file.test.ts`; modify `src/main/store/settings.ts`.

**Interfaces:** `loadJsonWithRecovery(path, defaults, deps): {value; recoveredFrom?: string}`.

- [ ] Test valid JSON, missing file, malformed JSON backup, timestamp collision suffixes, and backup failure fallback.
- [ ] Verify RED.
- [ ] Implement move-to-`.corrupt-<timestamp>` recovery and default persistence.
- [ ] Verify focused tests plus seed tests.
- [ ] Commit: `fix: preserve corrupt settings for recovery`.

### Task 13: Runtime Settings Validation and Migration

**Files:** Create `src/shared/settings-schema.ts`; create `tests/settings-schema.test.ts`; modify `src/main/store/settings.ts`.

**Interfaces:** `sanitizeSettings(raw: unknown, platform: OSPlatform): Settings`.

- [ ] Test enum rejection, numeric clamps, unknown-key removal, boolean/string coercion, obsolete Option trigger migration, and platform defaults.
- [ ] Verify RED.
- [ ] Implement explicit field-by-field sanitation using `DEFAULT_SETTINGS`.
- [ ] Verify schema and settings tests.
- [ ] Commit: `fix: validate and migrate persisted settings`.

### Task 14: Atomic Permission-Restricted Secret Persistence

**Files:** Modify `src/main/store/settings.ts`, `src/main/store/atomic-file.ts`; extend `tests/settings-file.test.ts`.

**Interfaces:** Secrets always use atomic writes and POSIX mode `0600`; existing permissive files are repaired.

- [ ] Test mode `0600`, chmod repair, atomic replacement, and no secret data in thrown messages.
- [ ] Verify RED.
- [ ] Implement permission repair and safe error wrapping.
- [ ] Verify settings and secret-scan tests.
- [ ] Commit: `security: harden local secret persistence`.

### Task 15: Endpoint URL Validation and Normalization

**Files:** Create `src/shared/endpoints.ts`, `tests/endpoints.test.ts`; modify `src/main/store/seed.ts`, `src/main/store/settings.ts`.

**Interfaces:** `normalizeEndpoint(value: string, options: {optional:boolean}): {value:string; error?:string}`.

- [ ] Test HTTP(S), trailing separators, whitespace, empty optional values, embedded credentials, unsupported schemes, invalid URLs, and `/v1` preservation.
- [ ] Verify RED.
- [ ] Implement normalization with the standard `URL` parser and integrate settings/seed paths.
- [ ] Verify endpoint, seed, and settings tests.
- [ ] Commit: `fix: normalize configured service endpoints`.

### Task 16: Sync Request Timeouts and Cancellation

**Files:** Create `src/main/sync/request.ts`; create `tests/sync-request.test.ts`; modify `src/main/sync/client.ts` and `src/main/index.ts`.

**Interfaces:** `fetchWithTimeout(input, init, {timeoutMs, signal, fetch}): Promise<Response>`; `SyncClient.syncOnce(signal?)`.

- [ ] Test timeout abort, caller abort, timer cleanup, successful completion, and no cursor advancement after abort.
- [ ] Verify RED.
- [ ] Implement composed abort signals and pass shutdown cancellation from the app lifecycle.
- [ ] Verify sync request/client/runner tests.
- [ ] Commit: `fix: bound and cancel sync requests`.

### Task 17: Bounded Sync Retry and Backoff

**Files:** Create `src/main/sync/retry.ts`; create `tests/sync-retry.test.ts`; modify `src/main/sync/client.ts`.

**Interfaces:** `withSyncRetry<T>(operation, {retries, sleep, random, signal}): Promise<T>`; retry classifier accepts network, 408, 429, and 5xx only.

- [ ] Test retryable/permanent statuses, capped delays, jitter bounds, cancellation, success after retry, and exhaustion.
- [ ] Verify RED.
- [ ] Implement injected deterministic policy and wrap pull/push fetches.
- [ ] Verify focused sync tests.
- [ ] Commit: `fix: retry transient sync failures safely`.

### Task 18: Reusable Native-Helper Supervision

**Files:** Create `src/main/native/helper-supervisor.ts`; create `tests/helper-supervisor.test.ts`.

**Interfaces:** `HelperSupervisor` accepts `spawn`, `setTimer`, `clearTimer`, `baseDelayMs`, `maxDelayMs`; exposes `start()`, `markReady()`, `stop()`, `onExit()`.

- [ ] Test expected stop, crash restart, exponential cap, readiness reset, duplicate start suppression, and timer cleanup.
- [ ] Verify RED.
- [ ] Implement an event-driven state machine with no polling interval.
- [ ] Verify focused tests.
- [ ] Commit: `feat: supervise native helper processes`.

### Task 19: Hotkey Helper Automatic Recovery

**Files:** Modify `src/main/hotkey/listener.ts`, `src/main/index.ts`; extend `tests/helper-supervisor.test.ts` and `tests/platform.test.ts`.

**Interfaces:** `HotkeyListener` delegates unexpected exit recovery to `HelperSupervisor` and preserves latest trigger/options.

- [ ] Test crash recovery, rapid-crash backoff, trigger update before restart, and no restart after `stop()`.
- [ ] Verify RED.
- [ ] Integrate supervisor, reattach stdout/stderr handlers per process, and make shutdown final.
- [ ] Verify hotkey, machine, supervisor, and platform tests.
- [ ] Commit: `fix: recover the global hotkey helper`.

### Task 20: Bounded Rotating Diagnostic Logs

**Files:** Create `src/main/logging/rotating-log.ts`; create `tests/rotating-log.test.ts`; modify `src/main/hotkey/listener.ts`, `src/main/insert/paste-deps.ts`.

**Interfaces:** `RotatingLog({path,maxBytes,backups,redact,fs})`; `append(line): void`; `redactDiagnostic(text): string`.

- [ ] Test size rotation, backup cap, multiline normalization, home-path/query/token redaction, and write failure tolerance.
- [ ] Verify RED.
- [ ] Implement bounded append/rename and replace direct log writes.
- [ ] Verify focused logging and paste tests.
- [ ] Commit: `fix: rotate and redact diagnostic logs`.

### Task 21: Copyable Redacted Diagnostics Report

**Files:** Create `src/shared/diagnostic-report.ts`, `tests/diagnostic-report.test.ts`; modify `src/shared/types.ts`, `src/main/diagnostics.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/dashboard/pages/Diagnostics.tsx`.

**Interfaces:** `buildDiagnosticReport(input): string`; new `diagnostics.report(): Promise<string>` IPC method.

- [ ] Test stable sections, secret/path/transcript redaction, unavailable fields, and platform/version fields.
- [ ] Verify RED.
- [ ] Add report generation, IPC, and a Lucide Copy button with success toast.
- [ ] Verify focused tests, typecheck, and renderer build.
- [ ] Commit: `feat: copy a redacted diagnostics report`.

### Task 22: Transcript JSON Export

**Files:** Create `src/shared/history-export.ts`, `tests/history-export.test.ts`; modify types, IPC, preload, and `History.tsx`.

**Interfaces:** `serializeHistoryJson(rows: Transcript[]): string`; `history.export('json', filters): Promise<string|null>`.

- [ ] Test versioned shape, deterministic ordering, null cleaned text, and omission of `audio_path`.
- [ ] Verify RED.
- [ ] Implement serializer, save dialog adapter, IPC/preload method, and Export menu command.
- [ ] Verify focused tests and typecheck.
- [ ] Commit: `feat: export transcript history as JSON`.

### Task 23: Transcript CSV Export

**Files:** Modify `src/shared/history-export.ts`, tests, IPC, preload, and History export menu.

**Interfaces:** `serializeHistoryCsv(rows: Transcript[]): string` emits UTF-8 RFC 4180 records.

- [ ] Test commas, quotes, CR/LF normalization, multiline text, nulls, and formula-like leading characters as quoted text.
- [ ] Verify RED.
- [ ] Implement CSV escaping and add CSV save option.
- [ ] Verify focused tests and typecheck.
- [ ] Commit: `feat: export transcript history as CSV`.

### Task 24: History Status and Date Filters

**Files:** Modify `src/shared/types.ts`, `src/main/store/history.ts`, `tests/history.test.ts`, `src/renderer/dashboard/pages/History.tsx`.

**Interfaces:** Extend `ListOpts` with `status?: TranscriptStatus|'all'`, `from?: number`, `to?: number`.

- [ ] Test each filter, combined filters, pagination stability, invalid range handling, and query parameter binding.
- [ ] Verify RED.
- [ ] Add parameterized SQL predicates and compact status/date controls beside search.
- [ ] Verify history tests, typecheck, and renderer build.
- [ ] Commit: `feat: filter transcript history by status and date`.

### Task 25: Failed and Empty History Cleanup

**Files:** Modify `src/main/store/history.ts`, `tests/history.test.ts`, shared types/IPC/preload, `History.tsx`.

**Interfaces:** `HistoryStore.deleteByStatuses(statuses: TranscriptStatus[]): {deleted:number; audioPaths:string[]}`.

- [ ] Test only failed/empty deletion, successful-row preservation, tombstones/sync metadata, audio path collection, and zero-match behavior.
- [ ] Verify RED.
- [ ] Implement transactional store operation, audio cleanup, confirmation dialog, and result toast.
- [ ] Verify focused tests and typecheck.
- [ ] Commit: `feat: clean failed transcript history`.

### Task 26: Dictionary JSON Import

**Files:** Create `src/shared/dict-import.ts`, `tests/dict-import.test.ts`; modify dictionary store, types/IPC/preload, `Dictionary.tsx`.

**Interfaces:** `parseDictionaryImport(text): DictionaryImportResult`; `dictionary.import(): Promise<DictionaryImportSummary|null>`.

- [ ] Test version validation, malformed JSON, row validation, duplicate canonical words, invalid aliases, and mixed valid/invalid input.
- [ ] Verify RED.
- [ ] Implement parser, open dialog, per-entry merge transaction, and summary toast.
- [ ] Verify dictionary/import tests and typecheck.
- [ ] Commit: `feat: import versioned dictionaries`.

### Task 27: Dictionary Alias Conflict Merging

**Files:** Create `src/shared/dictionary-conflicts.ts`, `tests/dictionary-conflicts.test.ts`; modify dictionary store/import and `Dictionary.tsx`.

**Interfaces:** `findAliasConflicts(entries, proposed): AliasConflict[]`; store returns conflicts without applying ambiguous aliases.

- [ ] Test case-insensitive aliases, canonical-word collisions, same-word merge, multiword boundaries, and deterministic conflict ordering.
- [ ] Verify RED.
- [ ] Implement conflict detection, safe merge, and visible conflict summary/action.
- [ ] Verify focused dictionary tests.
- [ ] Commit: `fix: prevent ambiguous dictionary aliases`.

### Task 28: Snippet Search and Filtering

**Files:** Create desktop `src/renderer/dashboard/pages/Snippets.tsx`; modify sidebar/types/IPC/preload as needed; modify Android `SnippetsActivity.kt`; create `src/shared/snippet-search.ts`, `tests/snippet-search.test.ts`, and Kotlin mirror tests.

**Interfaces:** `filterSnippets(snippets, query): Snippet[]`; case-insensitive stable matching over cue and expansion.

- [ ] Test empty query, cue/expansion matches, case folding, stable order, and whitespace normalization in TypeScript and Kotlin.
- [ ] Verify RED in both suites.
- [ ] Add desktop snippets page/search and Android search field using mirrored pure logic.
- [ ] Verify desktop tests/typecheck/build and Android focused tests/lint.
- [ ] Commit: `feat: search voice snippets across platforms`.

### Task 29: Inline Endpoint Validation in Settings

**Files:** Modify `src/shared/endpoints.ts`, tests, `Field.tsx`, `Settings.tsx`, and Android settings activity/layout/strings.

**Interfaces:** Field validation uses the Task 15 normalizer; invalid required endpoints block save while empty optional endpoints pass.

- [ ] Test UI-facing validation messages and Android mirror behavior for malformed scheme, credentials, required empty, and valid tailnet HTTP.
- [ ] Verify RED.
- [ ] Add accessible error text/`aria-invalid`, save gating, Android `TextInputLayout.error`, and normalization on save.
- [ ] Verify desktop and Android suites/builds.
- [ ] Commit: `feat: validate service endpoints before save`.

### Task 30: Version Platform and Build Information

**Files:** Create `src/shared/build-info.ts`, `tests/build-info.test.ts`; modify shared types/IPC/preload, `Diagnostics.tsx`, Android Settings/About strings and activity, package/Gradle metadata wiring.

**Interfaces:** `BuildInfo {appVersion; platform; arch; runtime; channel}`; `system.buildInfo(): Promise<BuildInfo>`.

- [ ] Test stable formatting, unknown channel fallback, packaged/dev distinction, and Android version mapping.
- [ ] Verify RED.
- [ ] Read runtime/package metadata in main, expose typed IPC, render a compact Diagnostics section, and show Android versionName/versionCode.
- [ ] Verify all desktop and Android gates.
- [ ] Commit: `feat: show build and platform information`.

---

## Final Verification and Push

- [ ] Confirm `git rev-list --count <merged-baseline>..HEAD` equals 30 and inspect all subjects.
- [ ] Run `npm run check`, `npm run check:secrets`, and `npm run verify:release` where artifacts exist.
- [ ] Run Android `testDebugUnitTest lintDebug assembleDebug --no-daemon` with JDK 17/SDK 34.
- [ ] Run `git diff --check`, confirm a clean worktree, and scan tracked paths for forbidden artifacts.
- [ ] Rebuild/install the macOS app if runtime desktop files changed; verify code signature, LaunchAgent, helper trust, native English control, and synthetic Option event.
- [ ] Push `main` with transport settings suitable for the repository's existing large native-helper history.
- [ ] Confirm `git ls-remote origin refs/heads/main` equals local `HEAD`.

