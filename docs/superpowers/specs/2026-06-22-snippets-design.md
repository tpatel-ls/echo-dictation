# Snippets (Phase 3 of the Wispr-Flow parity track)

**Date:** 2026-06-22 · **Platform:** Android (authoring + expansion) + sync server · **Status:** implemented

## Goal

Speak a short cue and Echo pastes a full canned block (address, scheduling link, signature,
boilerplate reply) — Wispr Flow's snippet library.

## Decisions (locked with the user)

1. **Trigger — exact cue match.** If the whole dictation matches a snippet's cue (case-, whitespace-,
   and trailing-punctuation-insensitive), paste the expansion; otherwise insert literally. Saying a
   cue mid-sentence does not expand (near-zero false positives). (Rejected: keyword prefix; inline.)
2. **Scope — Android author + expand + sync** (the rest delegated to "do everything you recommend").

## Architecture

- **`snippet/Snippets.kt`** (new, pure, tested): `Snippet(cue, expansion)` + `expandSnippet(text,
  snippets)` with normalized whole-utterance exact match. 7 tests.
- **Own database, no migration:** snippets live in a fresh **`SnippetDatabase`** (Room v1) rather than
  bumping `echo.db` — a migration would risk the existing synced dictionary and can't be verified
  without a device. New `SnippetEntity`, `SnippetDao`, `SnippetStore` (CRUD + `active()` domain +
  `syncCollections()`), and `SnippetSyncCollection` (mirrors `DictionarySyncCollection`).
- **Expansion in the pipeline:** `DictationController.stopAndTranscribe` checks `expandSnippet` after
  the dictionary pass; a hit pastes the canned block and skips cleanup. Works on the keyboard and the
  floating mic (both already route through the controller).
- **Sync:** the snippet collection is appended to the `SyncClient`'s list. The server is
  collection-agnostic (opaque payloads), so enabling sync was one line — `'snippets'` added to
  `COLLECTIONS` in `src/server/http.ts` — plus a round-trip test.
- **Authoring UI:** `SnippetsActivity` (+ `activity_snippets.xml`, `snippet_row.xml`) — add / edit /
  delete cue→expansion, opened from a "Manage snippets" button in Settings. DB calls run on a
  background thread (no RecyclerView; snippet counts are small, so a simple inflated list suffices).

## Testing

- **Pure/TDD:** `SnippetsTest` (exact / case+punctuation / whitespace / mid-sentence-no-expand /
  no-match / blank / first-wins). Full Android suite green.
- **Server/TDD:** `sync-http.test.ts` round-trips a snippet record; full desktop suite green (192).
- **On-device:** add a snippet (cue "my address" → a block) in Settings → Manage snippets; dictate
  exactly "my address" in any field → the block is pasted; saying it in a sentence inserts literally.

## Deferred / follow-ups

- Desktop authoring/expansion (snippets already sync, so a desktop UI is a clean follow-up).
- Fuzzy cue matching; per-snippet usage stats. Next Wispr-parity phase: Multilingual UX.
