// ─────────────────────────────────────────────────────────────────────────────
// Deterministic fixes for misheard participant names ("Deren" for Darin, "Thane" for Tanay), given
// the names of people Echo knows (calendar attendees, confirmed speakers, remembered voices, the user).
// Conservative on purpose: only capitalised words (or a two-word split in address position, like
// "it's dare in") that sound like a known name, are spelt close to it, share its first vowel's
// quality, and are not common English words. A surname heard right after its person's first name
// ("Darin Kudira") is fixed without the vowel rule. Pure.
// ─────────────────────────────────────────────────────────────────────────────

/** Distinct name parts of 4+ letters ("Darin Kadiro" gives Darin and Kadiro). */
export function nameTokens(names: string[]): string[] {
  const out: string[] = []
  for (const name of names) {
    for (const part of name.split(/[\s-]+/)) {
      const clean = part.replace(/[^\p{L}']/gu, '')
      if (clean.length >= 4 && !out.some((o) => o.toLowerCase() === clean.toLowerCase())) out.push(clean)
    }
  }
  return out
}

/** Common words that sound like names; never corrected even when capitalised. */
const COMMON = new Set(
  (
    'about after again against also alright always another answer anyone anything around away back because been before being ' +
    'better between both bring built call came cannot come could daily data date day deal done down each early either else ' +
    'even ever every fine first from gonna good great half hand have hello help here hold into item just keep kind last later ' +
    'least left less like line little long look made main make many maybe mean might more most much must name need never next ' +
    'nice none note nothing okay once only open other over part people perfect plan point pretty quite rather ready really right ' +
    'same said should show since some something soon sorry start still such sure take talk tell than thank thanks that then ' +
    'there these they thing think this those though time today tone tiny town turn tune under until upon used very want well ' +
    'went were what when where which while will with within without work would year yeah your alone alter atlas title ' +
    'tony tina tim tom tan ten tin ton dany dinner dine done dean dane tone tannin total detail detain datum'
  ).split(' ')
)

/** Sound classes: letters that are easily confused in speech share a class; vowels collapse. */
function phoneticKey(word: string): string {
  const w = normalize(word)
  let key = ''
  for (let i = 0; i < w.length; i++) {
    const ch = w[i]
    let cls: string
    if ('aeiouy'.includes(ch)) cls = i === 0 ? 'V' : ''
    else if ('bp'.includes(ch)) cls = 'P'
    else if ('dt'.includes(ch)) cls = 'T'
    else if ('ckqg'.includes(ch)) cls = 'K'
    else if ('fv'.includes(ch)) cls = 'F'
    else if ('szx'.includes(ch)) cls = 'S'
    else if ('hw'.includes(ch)) cls = ''
    else cls = ch.toUpperCase()
    if (cls && !key.endsWith(cls)) key += cls
  }
  return key
}

/** Lower-case letters only, with the common spelling digraphs simplified. */
function normalize(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/th/g, 't')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/e$/, '')
}

/** The first vowel's quality: front (a, e, i) or back (o, u). */
function firstVowelGroup(word: string): string | null {
  const v = /[aeiouy]/.exec(normalize(word))?.[0]
  if (!v) return null
  return 'aei'.includes(v) ? 'front' : 'back'
}

export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length]
}

/** Which known name `word` is a mishearing of, or null. `looser` allows a one-class slip (bigrams). */
function closestName(word: string, names: string[], looser = false): string | null {
  const lower = word.toLowerCase()
  if (lower.length < 4 || COMMON.has(lower) || names.some((n) => n.toLowerCase() === lower)) return null
  const key = phoneticKey(word)
  for (const name of names) {
    const nameKey = phoneticKey(name)
    const distance = editDistance(normalize(word), normalize(name))
    const soundsAlike = looser ? editDistance(key, nameKey) <= 1 && distance <= 1 : key === nameKey
    if (!soundsAlike || distance > Math.max(1, Math.floor(name.length / 2))) continue
    if (Math.abs(word.length - name.length) > 2 || firstVowelGroup(word) !== firstVowelGroup(name)) continue
    return name
  }
  return null
}

/** Words before a two-word split that make it a form of address ("it's dare in", "hi dare in"). */
const ADDRESS_BEFORE = new Set(["it's", 'its', 'is', 'hi', 'hey', 'thanks', 'you', 'bye', 'dear'])

/**
 * A surname heard right after its person's first name ("Darin Kudira"): the pair is strong evidence,
 * so the first-vowel rule is not applied, but it must still sound and be spelt alike.
 */
function isSurname(word: string, surname: string): boolean {
  const lower = word.toLowerCase()
  if (lower.length < 4 || COMMON.has(lower) || lower === surname.toLowerCase()) return false
  if (Math.abs(word.length - surname.length) > 2 || phoneticKey(word) !== phoneticKey(surname)) return false
  return editDistance(normalize(word), normalize(surname)) <= Math.max(1, Math.floor(surname.length / 2))
}

/**
 * Correct misheard names in `text`. `names` are known people: full names ("Darin Kadiro") or
 * single names; each part of 4+ letters is a candidate, and a full name also fixes its surname
 * when heard right after the first name.
 */
export function correctNames(text: string, names: string[]): { text: string; fixes: Array<{ from: string; to: string }> } {
  const fixes: Array<{ from: string; to: string }> = []
  const tokens = nameTokens(names)
  if (tokens.length === 0) return { text, fixes }
  const fullNames = names
    .map((n) => n.trim().split(/\s+/))
    .filter((p) => p.length >= 2)
    .map((p) => ({ first: p[0], last: p[p.length - 1] }))
  // Words with their trailing possessive kept apart, so "Tanya's" becomes "Tanay's".
  const parts = text.split(/(\s+)/)
  for (let i = 0; i < parts.length; i++) {
    const m = /^([^\p{L}]*)(\p{L}+)('s)?([^\p{L}]*)$/u.exec(parts[i])
    if (!m) continue
    const [, lead, word, possessive = '', trail] = m
    const capitalised = /^\p{Lu}\p{Ll}+$/u.test(word)
    if (capitalised) {
      const name = closestName(word, tokens)
      const first = name ?? tokens.find((t) => t.toLowerCase() === word.toLowerCase()) ?? null
      // "Daren Kudira" / "Darin Kadira": a first name followed by its person's misheard surname.
      const next = first && !possessive && !trail && parts[i + 2] ? /^(\p{Lu}\p{Ll}+)('s)?([^\p{L}]*)$/u.exec(parts[i + 2]) : null
      const person = next ? fullNames.find((f) => f.first.toLowerCase() === first!.toLowerCase() && isSurname(next[1], f.last)) : undefined
      if (person && next) {
        parts[i] = `${lead}${person.first}`
        parts[i + 2] = `${person.last}${next[2] ?? ''}${next[3]}`
        fixes.push({ from: `${word} ${next[1]}`, to: `${person.first} ${person.last}` })
        i += 2
        continue
      }
      if (name) {
        parts[i] = `${lead}${name}${possessive}${trail}`
        fixes.push({ from: word, to: name })
      }
      continue
    }
    // Two short lower-case words in address position that together spell a name: "dare in".
    const next = parts[i + 2] ? /^(\p{Ll}+)([^\p{L}]*)$/u.exec(parts[i + 2]) : null
    const before = (parts[i - 2] ?? '').toLowerCase().replace(/[^\p{L}']/gu, '')
    if (!next || lead || trail || word.length > 4 || next[1].length > 4 || !ADDRESS_BEFORE.has(before)) continue
    const joined = word + next[1]
    const name = closestName(joined, tokens, true)
    if (!name) continue
    parts[i] = name
    parts[i + 1] = ''
    parts[i + 2] = next[2]
    fixes.push({ from: `${word} ${next[1]}`, to: name })
    i += 2
  }
  return { text: parts.join(''), fixes }
}
