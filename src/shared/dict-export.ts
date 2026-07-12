import type { DictionaryEntry, DictionarySource } from './types'
import { buildBiasPrompt } from './dictionary'

/**
 * Portable snapshot of the dictionary. The `prompt` field is the exact Whisper bias
 * string — paste it into another client's "prompt"/"initial prompt" box (e.g. an
 * Android voice keyboard) to carry your spelling preferences to that device without
 * running Echo there.
 */
export interface DictionaryExport {
  version: 1
  entries: { word: string; misheard: string[]; source: DictionarySource }[]
  prompt: string
}

export interface DictionaryImportEntry {
  word: string
  misheard: string[]
  source: DictionarySource
}

export interface DictionaryImportParse {
  entries: DictionaryImportEntry[]
  skipped: number
}

/** Reduce live entries to the portable shape (drops ids/timestamps/usage counts). */
export function serializeDictionary(entries: DictionaryEntry[]): DictionaryExport {
  return {
    version: 1,
    entries: entries.map((e) => ({ word: e.word, misheard: e.misheard, source: e.source })),
    prompt: buildBiasPrompt(entries)
  }
}

export function parseDictionaryImport(raw: string): DictionaryImportParse {
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch {
    throw new Error('Dictionary import must be valid JSON')
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Dictionary import must be a versioned object')
  }
  const value = document as Record<string, unknown>
  if (value.version !== 1) throw new Error('Unsupported dictionary export version')
  if (!Array.isArray(value.entries)) throw new Error('Dictionary import has no entries array')

  const entries: DictionaryImportEntry[] = []
  let skipped = Math.max(0, value.entries.length - 10_000)
  for (const candidate of value.entries.slice(0, 10_000)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      skipped++
      continue
    }
    const entry = candidate as Record<string, unknown>
    const word = typeof entry.word === 'string' ? entry.word.trim().replace(/\s+/g, ' ') : ''
    if (!word || word.length > 200 || !Array.isArray(entry.misheard)) {
      skipped++
      continue
    }
    if (entry.misheard.some((alias) => typeof alias !== 'string')) {
      skipped++
      continue
    }
    const misheard = (entry.misheard as string[])
      .map((alias) => alias.trim().replace(/\s+/g, ' '))
      .filter((alias) => alias.length > 0 && alias.length <= 200)
      .slice(0, 50)
    entries.push({
      word,
      misheard,
      source: entry.source === 'learned' ? 'learned' : 'manual'
    })
  }
  return { entries, skipped }
}
