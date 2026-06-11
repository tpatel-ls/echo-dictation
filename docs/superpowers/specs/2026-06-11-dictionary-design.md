# Echo — Personal Dictionary & Auto-Correction (Design)

**Date:** 2026-06-11
**Status:** Approved (user delegated remaining decisions to recommended options)

## Goal

Stop Whisper from repeating the same misrecognitions (e.g. "Bryan" → "Brian"). A personal
dictionary, à la Wispr Flow: corrections are learned automatically from transcript edits and
applied to every future dictation, so a mistake corrected once never happens again.

## Constraint that shapes the design

Echo pastes into other apps and never sees what happens after the paste, so it cannot watch
the user fix text in Notepad/Slack (Wispr Flow does this via deep OS text-field integration).
Learning therefore happens **inside Echo**: edits made in the History page, plus manual entries.

## Decisions

| Decision | Choice |
|---|---|
| Capture | Edit action on History rows → diff old vs new → auto-learn; plus manual Dictionary page |
| Learning UX | Auto-add silently, toast "Learned: Brian → Bryan" with one-click Undo |
| Application | Two layers: Whisper `prompt` biasing (prevention) + deterministic word-boundary replacement (guarantee) |
| Entry model | Canonical `word` + `misheard[]` aliases. Word-only entries bias; aliases also replace |
| Storage | `dictionary` table in existing `history.sqlite` (sql.js), same debounced atomic persist |
| Claude cleanup | System prompt gains glossary of canonical words so polish never "fixes" them back |
| Raw text stored | Post-replacement text (what was actually pasted) |

## Data model

```sql
CREATE TABLE IF NOT EXISTS dictionary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,              -- canonical spelling: "Bryan"
  misheard TEXT NOT NULL DEFAULT '[]',  -- JSON array of aliases: ["Brian"]
  source TEXT NOT NULL,            -- 'manual' | 'learned'
  created_at INTEGER NOT NULL,
  times_applied INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_dictionary_word ON dictionary(word COLLATE NOCASE);
```

Adding an existing word (case-insensitive) merges aliases into the existing entry (upsert).
Aliases are deduped case-insensitively; an alias exactly equal to its word is dropped.

## Pure logic (`src/shared/dictionary.ts`, TDD)

- `applyDictionary(text, entries) → { text, appliedIds }` — for every alias (longest first so
  multi-word aliases win over substrings), case-insensitive whole-word match via
  unicode-aware boundaries (`(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`), flexible whitespace inside
  multi-word aliases, replace with canonical `word`. Regex-escaped, so no injection. Returns
  ids of entries that changed text (for `times_applied`).
- `buildBiasPrompt(entries, maxChars≈600) → string` — canonical words only (aliases would
  bias toward the *wrong* spelling), sorted by `times_applied` then recency, comma-joined,
  truncated to stay safely under Whisper's 224-token prompt window.
- `extractCorrections(before, after) → {from,to}[]` — word-level LCS diff; collapse adjacent
  changes into substitution pairs. Filters: punctuation-only changes; pure insertions or
  deletions; either side > 3 words (rephrasing); sentence-case-only changes (`brian→Brian`,
  `the→The`) — but internal-case changes (`github→GitHub`) are kept; if > 40% of a transcript
  (≥ 8 words) changed, treat the edit as a rewrite and learn nothing.

## Hot path (dictation.ts)

```
entries = dictionary.list()
raw     = transcribe(wav, …, { prompt: buildBiasPrompt(entries) })
{ text, appliedIds } = applyDictionary(raw, entries)        // microseconds
dictionary.recordApplied(appliedIds)
… cleanup(text, …, glossary) when auto … paste … store text as raw_text
```

Dictionary failures never break dictation (try/catch → fall back to unmodified text).
If the Whisper server 4xxes a request that included `prompt`, retry once without it
(some servers may reject unknown fields; most ignore them).

## Learning flow

`history:edit (id, newText)` in main:
1. `before` = displayed text (`cleaned_text ?? raw_text`); update that column + `word_count`.
2. `extractCorrections(before, newText)`; skip pairs already covered by the dictionary
   (alias exists, or `from` equals an entry's canonical word, case-insensitive).
3. Upsert the rest as `source:'learned'`; respond with `{ transcript, learned[] }` where each
   learned item records `entryId`, `from`, and whether the entry was newly created.
4. Renderer toasts "Learned: Brian → Bryan" with **Undo** → deletes the created entry, or
   just removes the added alias from a pre-existing entry.

## IPC / API surface

New channels: `history:edit`, `dict:list`, `dict:add`, `dict:update`, `dict:delete`,
`dict:undoLearn`. Preload bridge gains `history.edit(id, text)` and
`dictionary.{list,add,update,remove,undoLearn}`.

## UI

- **Sidebar**: new "Dictionary" page (book icon) after History.
- **Dictionary page**: add-word form (word + optional "misheard as"), entry list with word,
  alias chips (removable, inline add), source badge for learned entries, times-applied count,
  delete. Empty state explains the feature.
- **TranscriptRow**: pencil Edit action → textarea with Save/Cancel.
- **Toast**: gains an optional action button (used for Undo).

No new settings — biasing turns on automatically once the dictionary is non-empty (YAGNI).

## Error handling

Store errors surface as dashboard toasts (existing pattern). Bad/duplicate input normalized
at the store boundary. All replacement regexes built from escaped literals.

## Testing

TDD pure logic: applyDictionary (boundaries, casing, multi-word, overlap precedence,
idempotence), buildBiasPrompt (ordering, cap, empty), extractCorrections (each filter,
run collapsing, rewrite bail). Store tests on in-memory sql.js (upsert/merge/undo paths).
Client tests with mocked fetch: prompt field present, 4xx-without-prompt fallback, glossary
in Claude system prompt. History edit updates the right column. UI verified via typecheck +
build + manual smoke.
