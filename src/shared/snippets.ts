// Voice snippets: speak a cue, paste a saved block. Pure matcher shared with the store layer;
// mirrors the Android snippet/Snippets.kt so a cue authored on the phone expands on the desktop.

export interface Snippet {
  cue: string
  expansion: string
}

export interface StoredSnippet extends Snippet {
  id: number
  created_at: number
}

/**
 * If `text` (the whole dictation) matches a snippet's cue — ignoring case, surrounding whitespace,
 * collapsed inner spaces, and trailing sentence punctuation — return its expansion; else null. The
 * whole-utterance match means saying a cue inside a sentence inserts the words literally. First wins.
 */
export function expandSnippet(text: string, snippets: Snippet[]): string | null {
  const key = normalizeCue(text)
  if (!key) return null
  const hit = snippets.find((s) => normalizeCue(s.cue) === key)
  return hit ? hit.expansion : null
}

function normalizeCue(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.,!?;:'"]+|[.,!?;:'"]+$/g, '')
    .trim()
}
