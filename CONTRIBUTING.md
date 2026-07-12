# Contributing to Echo

## Before you start

Use Node.js 20 or newer, npm 10 or newer, JDK 17, and Android SDK 34. Install dependencies with
`npm install`; the preflight reports unsupported toolchains before a long build starts.

Keep changes narrowly scoped and follow the patterns already present in the affected platform.
Write the test first for pure logic, stores, clients, parsers, and bug fixes. Run it once while it
fails for the intended reason, implement the smallest correction, and then run the surrounding
suite.

## Required checks

```bash
npm run check:desktop
npm run check:android
npm run check:secrets
```

Run focused tests during development and the complete applicable gate before opening a pull
request. Windows hooks and SendInput need a Windows x64 execution check; macOS signatures and
privacy helpers need a Mac; Android UI behavior needs a device or emulator when it cannot be proven
by JVM tests.

## Repository safety

- No credentials, personal endpoint hostnames, local seed files, retained audio, databases, or
  generated installers belong in git.
- Never push `private-history`.
- Do not rewrite public branch history or force-push `main`.
- Preserve unrelated user changes in a dirty worktree.
- No AI attribution, generated-by footers, or automated co-author trailers in commits.

## Commits and pull requests

Use small commits with an imperative subject such as `fix: restore clipboard after paste failure`.
Explain observable behavior and risk in the pull request, not a line-by-line narration. Include the
platforms tested, exact commands run, and any device-only verification that remains.

UI changes should include screenshots at representative desktop and mobile sizes. Security reports
must use the private process in `SECURITY.md`, not a public pull request.
