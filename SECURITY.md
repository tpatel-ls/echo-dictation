# Security Policy

## Supported versions

Security fixes are applied to the latest commit on `main`. Older source snapshots and locally
modified builds are not maintained as separate supported releases.

## Report a vulnerability

Please report suspected vulnerabilities privately through GitHub's **Security** tab using
**Report a vulnerability**. Do not include exploit details, credentials, private endpoints, audio,
or transcript content in a public issue.

Include the affected platform, Echo version or commit, reproduction steps using non-sensitive test
data, and the security impact. You should receive an acknowledgement within three business days.
Validated reports will receive a remediation plan before public disclosure.

## Data boundaries

Echo is a local client for endpoints selected by the user:

- Recorded audio is sent only to the configured speech-to-text endpoint.
- Transcript text is sent to the configured AI endpoint only when adjudication, cleanup, or a voice
  command needs it.
- Sync sends transcript metadata, dictionary entries, and snippets only to the configured sync
  service. Audio is not synced.
- macOS data lives under `~/Library/Application Support/echo`; Windows data lives under
  `%APPDATA%\echo`; Android data is stored in the app sandbox.
- Desktop credentials are stored in a permission-restricted per-user file. Android credentials use
  EncryptedSharedPreferences backed by the Android keystore.

Echo does not provide a hosted speech, AI, or sync service. Security and retention policies for a
configured third-party endpoint remain the endpoint operator's responsibility.

## Credential response

Never commit a real key, token, personal tailnet hostname, local seed file, retained audio, or
database. If credentials enter git history, revoke and rotate them immediately before attempting
repository cleanup. Treat removal from the latest commit as insufficient because old commits and
forks can retain the value.

## Out of scope

The following are not vulnerabilities by themselves:

- SmartScreen or Gatekeeper warnings for an unsigned/not-notarized personal build.
- An elevated target application rejecting paste from a non-elevated Echo process.
- A user-configured endpoint receiving the data that Echo explicitly sends to it.
- Physical access to an already unlocked user session.
