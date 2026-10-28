# Echo — Codex project notes

## Git conventions

- **Never add Codex attribution to git history.** No `Co-Authored-By: Codex …`
  trailers on commits, and no "Generated with Codex" footers in PR bodies.
  Commits are authored by the repo owner only.

## Commands

- Read `docs/HANDOFF.md` first when setting up a fork. `npm ci` then `npm run setup:local`
  installs the local model and native helpers; run `npm run speech:start` beside `npm run dev`.
- Keep GPU services optional. Fresh settings must work with the single `whisper-1` local alias.
- Packaged builds must never include `secrets.local.json`, user data, model caches or recordings.

- `npm test` — unit suite (Vitest, `tests/*.test.ts`)
- `npm run typecheck` — both tsconfig projects (node + web)
- `npm run build` — bundle main/preload/renderers to `out/`
- `npm run dev` — launch with hot reload

## Conventions

- TDD for pure logic (`src/shared/`, stores, clients) — tests live in `tests/`,
  mirroring existing style (vitest, mocked `fetch`, in-memory sql.js).
- `secrets.local.json` is gitignored and must never be committed; public-facing
  files must not contain personal endpoints (tailnet hostnames) or key material.
- Original private history is archived outside this repository; never restore or push it.
- `ECHO_USER_DATA` env var redirects userData + single-instance lock for isolated
  automated runs (see memory: echo-e2e-verification-recipe).
