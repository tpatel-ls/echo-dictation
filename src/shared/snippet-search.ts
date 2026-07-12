import type { Snippet } from './snippets'

export function filterSnippets<T extends Snippet>(snippets: T[], query: string): T[] {
  const needle = normalizeSearchText(query)
  if (!needle) return snippets
  return snippets.filter((snippet) =>
    normalizeSearchText(`${snippet.cue} ${snippet.expansion}`).includes(needle)
  )
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}
