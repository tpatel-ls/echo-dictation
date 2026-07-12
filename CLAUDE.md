# Echo — Claude Code project notes

## Git conventions

- **Never add Claude attribution to git history.** No `Co-Authored-By: Claude …`
  trailers on commits, and no "Generated with Claude Code" footers in PR bodies.
  Commits are authored by the repo owner only.

## Commands

- `npm test` — unit suite (Vitest, `tests/*.test.ts`)
- `npm run typecheck` — both tsconfig projects (node + web)
- `npm run build` — bundle main/preload/renderers to `out/`
- `npm run dev` — launch with hot reload
- `npm run check:desktop` — desktop tests, typechecks, native helpers, and production bundle
- `npm run check:android` — Android unit tests, lint, and debug APK
- `npm run check` — all desktop, Android, and tracked-secret gates

## Conventions

- TDD for pure logic (`src/shared/`, stores, clients) — tests live in `tests/`,
  mirroring existing style (vitest, mocked `fetch`, in-memory sql.js).
- `secrets.local.json` is gitignored and must never be committed; public-facing
  files must not contain personal endpoints (tailnet hostnames) or key material.
- The branch `private-history` is local-only — never push it.
- `ECHO_USER_DATA` env var redirects userData + single-instance lock for isolated
  automated runs (see memory: echo-e2e-verification-recipe).
