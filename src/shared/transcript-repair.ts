interface WordToken {
  raw: string
  start: number
  end: number
  normalized: string
}

/**
 * Repair a split spelling when the same transcript also contains the joined word.
 * This is deliberately evidence-based: "plant ain ... plantain" is safe to repair,
 * while an isolated phrase such as "plant inventory" is left exactly as heard.
 */
export function repairTranscriptConsistency(text: string): string {
  const tokens: WordToken[] = []
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const raw = match[0]
    const start = match.index
    tokens.push({ raw, start, end: start + raw.length, normalized: raw.toLowerCase() })
  }
  if (tokens.length < 3) return text

  const joinedSpellings = new Map<string, string>()
  for (const token of tokens) {
    if (!joinedSpellings.has(token.normalized)) joinedSpellings.set(token.normalized, token.raw)
  }

  const replacements: Array<{ start: number; end: number; value: string }> = []
  for (let index = 0; index < tokens.length - 1; index++) {
    const first = tokens[index]
    const second = tokens[index + 1]
    if (first.raw.length < 2 || second.raw.length < 2) continue
    if (!/^\s+$/.test(text.slice(first.end, second.start))) continue

    const combined = first.normalized + second.normalized
    if (combined.length < 6) continue
    const evidence = joinedSpellings.get(combined)
    if (!evidence) continue

    const normalizedEvidence = evidence.toLowerCase()
    const value = /^\p{Lu}/u.test(first.raw)
      ? normalizedEvidence[0].toUpperCase() + normalizedEvidence.slice(1)
      : normalizedEvidence
    replacements.push({ start: first.start, end: second.end, value })
    index++
  }

  let repaired = text
  for (const replacement of replacements.reverse()) {
    repaired = repaired.slice(0, replacement.start) + replacement.value + repaired.slice(replacement.end)
  }
  return repaired
}
