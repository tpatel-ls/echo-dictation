# Main Reliability and Product Improvement Program

## Goal

Promote the complete cross-platform Echo application to `main`, preserve the unique work on both
existing branches, and land exactly 30 new, substantive improvement commits: 20 focused on
reliability, security, CI, and release engineering, followed by 10 user-facing product
improvements.

## Branch Integration

The remote repository is `https://github.com/tpatel-ls/echo-dictation.git`. `main` and `mac`
diverged after their shared base: `main` contains one unique Willow cleanup commit and `mac`
contains 22 newer cross-platform accuracy, packaging, Android, and macOS commits. Integration must
use a normal merge without rewriting either history. Conflicts are resolved by preserving the
current `mac` behavior while auditing the `main` side for any unique Willow functionality.

The merged baseline is verified and pushed to `origin/main` before the 30-improvement program.
The 30 commits then land directly on local `main`, are verified as a group, and are pushed to the
same remote branch. `private-history` is never pushed. No force push is used.

## Commit Contract

- The merge commit and planning-document commits do not count toward the 30 improvements.
- Each improvement is a separate atomic commit with a focused message and meaningful diff.
- Pure logic, stores, network clients, and formatters follow test-driven development.
- No empty commits, timestamp-only changes, generated dependency trees, or contribution-count
  padding are permitted.
- Existing local credentials, endpoint files, databases, audio, and build artifacts remain ignored.
- Desktop and Android behavior stays compatible with the existing public wire formats.

## Reliability, Security, CI, and Release Improvements

### 1. Desktop CI Matrix

Add GitHub Actions coverage for dependency installation, the Vitest suite, TypeScript checks, a
macOS production build, and a Windows x64 production build. Use concurrency cancellation so stale
branch runs do not consume runners.

### 2. Android CI Pipeline

Add a JDK 17 and Android SDK 34 workflow that runs Android unit tests, lint, and debug APK assembly,
with Gradle caching and uploaded lint/APK artifacts.

### 3. CodeQL Security Analysis

Add scheduled and pull-request CodeQL analysis for JavaScript/TypeScript plus Java/Kotlin without
duplicating ordinary CI build work.

### 4. Dependabot Configuration

Configure grouped weekly updates for npm, Gradle, and GitHub Actions. Keep major upgrades separate
so they receive explicit review.

### 5. Tracked-Secret Detection

Add a deterministic repository scanner for known credential prefixes, forbidden local seed files,
private tailnet hostnames, and generated artifacts. Run it locally and in CI while allowing explicit
test fixtures that use obvious placeholders.

### 6. Release Artifact Verification

Add a script that verifies expected desktop helper names, PE/Mach-O architecture consistency,
macOS bundle signatures when available, Android APK presence, and SHA-256 manifest generation.
Separate pure artifact classification from shell execution for unit coverage.

### 7. Unified Quality Gates

Add canonical `check`, `check:desktop`, and `check:android` scripts so contributors and CI use the
same commands. The desktop gate includes tests, both TypeScript projects, and a production bundle;
the Android gate includes unit tests and lint.

### 8. Toolchain Metadata Enforcement

Declare the supported Node and npm versions, add a version preflight with actionable errors, and
align package metadata with macOS, Windows x64, and Android support.

### 9. Security Policy

Add a public security policy covering responsible disclosure, supported versions, credential
handling, local data locations, network boundaries, and response expectations.

### 10. Contribution and Pull-Request Standards

Add a contributor guide and pull-request template with platform-specific verification, secret
checks, TDD expectations, commit conventions, and artifact requirements.

### 11. Atomic Settings Persistence

Move desktop settings writes to a same-directory temporary file followed by rename. Ensure a failed
write never truncates the last good settings file.

### 12. Corrupt Settings Recovery

When settings JSON cannot be parsed, move it to a timestamped `.corrupt` backup, restore validated
defaults, and preserve seed behavior. Recovery must not silently overwrite forensic evidence.

### 13. Runtime Settings Validation and Migration

Coerce persisted settings through an explicit schema: clamp numeric ranges, accept only known enum
values, normalize booleans and strings, and migrate obsolete trigger values without trusting
arbitrary JSON keys.

### 14. Atomic Permission-Restricted Secret Persistence

Write desktop secrets atomically with mode `0600`, repair an overly permissive existing file on
POSIX systems, and avoid logging key material on failures.

### 15. Endpoint URL Validation and Normalization

Centralize URL normalization for Whisper, AI, and sync endpoints. Permit only HTTP(S), remove
accidental duplicate trailing separators, reject embedded credentials, and preserve intentionally
empty optional endpoints.

### 16. Sync Request Timeouts and Cancellation

Add bounded request timeouts with `AbortController` to desktop sync pulls and pushes. Cancellation
must not advance cursors or watermarks and shutdown must not leave timers referenced.

### 17. Bounded Sync Retry and Backoff

Retry only network errors, HTTP 408/429, and 5xx responses with capped exponential backoff. Never
retry authentication or malformed-request failures. Tests use injected sleep and deterministic
timing.

### 18. Reusable Native-Helper Supervision

Extract helper process lifecycle policy into a testable supervisor that tracks readiness, expected
shutdown, crashes, and capped restart delay without creating a polling loop.

### 19. Hotkey Helper Automatic Recovery

Use the supervisor to restart the global hotkey helper after an unexpected exit, avoid restart
storms, preserve updated trigger settings, and stop permanently during app shutdown.

### 20. Bounded Rotating Diagnostic Logs

Replace unbounded hotkey/paste logs with a small rotating logger. Redact home paths, endpoint query
strings, and bearer-like tokens; cap each log and retain only a fixed number of backups.

## User-Facing Product Improvements

### 21. Copyable Redacted Diagnostics Report

Generate a structured support report containing platform, version, permission states, helper
status, microphone health, and endpoint reachability without credentials, transcript text, or full
private paths. Add a copy command to Diagnostics.

### 22. Transcript JSON Export

Export filtered or complete transcript history as versioned JSON with timestamps and metadata but
without retained audio paths. Use a save dialog and report cancellation cleanly.

### 23. Transcript CSV Export

Export the same safe transcript fields as RFC 4180-compatible UTF-8 CSV with correct quoting for
commas, quotes, and multiline dictation.

### 24. History Status and Date Filters

Add compact filters for status and date range beside search. Filtering occurs in the store query so
large histories remain bounded and existing virtual scrolling remains stable.

### 25. Failed and Empty History Cleanup

Add a confirmation-protected command that removes failed/empty rows and their retained audio while
leaving successful transcripts untouched. The store operation is transactional and sync-aware.

### 26. Dictionary JSON Import

Accept Echo's versioned dictionary export, validate every record, merge valid words and aliases,
report skipped invalid rows, and never replace the entire dictionary on partial failure.

### 27. Dictionary Alias Conflict Merging

Detect aliases claimed by multiple canonical words during add/edit/import. Resolve exact canonical
duplicates deterministically and surface true cross-word conflicts for the user instead of silently
applying ambiguous replacements.

### 28. Snippet Search and Filtering

Add cue/expansion search to the desktop snippets view and Android snippets manager. Matching is
case-insensitive, stable, and does not alter snippet ordering or sync state.

### 29. Inline Endpoint Validation in Settings

Show field-level validation for Whisper, AI, and sync URLs before save. Invalid required fields
block saving; empty optional fields remain valid. The visual treatment uses the existing restrained
settings design.

### 30. Version, Platform, and Build Information

Expose app version, Electron/Node versions, OS/architecture, Android versionCode/versionName, and
build channel in Diagnostics/About surfaces. Values come from runtime/package metadata rather than
duplicated hard-coded UI strings.

## Architecture and Boundaries

Pure validation, export, filtering, retry policy, supervisor state, redaction, and artifact
classification live in focused modules with no Electron dependency. Electron IPC owns dialogs,
clipboard operations, and runtime metadata. Stores own persistence and transaction boundaries.
React components consume typed preload methods only. Android mirrors product behavior in Kotlin
where it has an equivalent screen or store and does not import desktop implementation details.

No new large runtime dependency is introduced. GitHub workflows may use maintained official
actions. File formats are versioned and public. Existing sync payloads remain backward compatible;
new local-only UI state is not synced.

## Error Handling

- CI and release scripts fail with one actionable message and nonzero exit status.
- Persistence keeps the last good file and a recoverable corrupt backup.
- Network retries are bounded and classify permanent failures correctly.
- Helper crashes recover without busy loops or hidden process accumulation.
- Export cancellation is not an error; partial writes are removed.
- Import reports valid, merged, conflicting, and skipped counts.
- Destructive cleanup requires explicit confirmation and removes associated audio.
- Diagnostics and logs never expose credentials, transcript text, or unredacted private paths.

## Testing and Verification

Every pure or stateful change starts with a failing focused test. Each improvement commit runs its
focused tests before commit. At integration checkpoints run:

```bash
npm test
npm run typecheck
npm run build
```

Android checkpoints run:

```bash
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug --no-daemon
```

Before the final push, run the unified gates, the tracked-secret scanner, release verifier,
`git diff --check`, and inspect the 30-commit range. Rebuild and reinstall the macOS app only when
runtime desktop changes require it; verify signature, LaunchAgent, helper trust, and a synthetic
Option-key event. Windows-specific hooks remain cross-built and architecture-inspected on macOS,
with on-device checks documented rather than falsely claimed.

## Delivery

1. Commit this design and the implementation plan.
2. Merge `mac` into local `main`, verify, and push the merged baseline to `origin/main`.
3. Implement improvements 1 through 30 in order, one tested commit each.
4. Run all final verification and credential scans.
5. Push the final `main` and verify the remote SHA directly.

