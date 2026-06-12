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

/** Reduce live entries to the portable shape (drops ids/timestamps/usage counts). */
export function serializeDictionary(entries: DictionaryEntry[]): DictionaryExport {
  return {
    version: 1,
    entries: entries.map((e) => ({ word: e.word, misheard: e.misheard, source: e.source })),
    prompt: buildBiasPrompt(entries)
  }
}
