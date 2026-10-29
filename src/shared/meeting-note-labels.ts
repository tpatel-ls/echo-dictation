import type { MeetingNotes, MeetingSpeaker, NoteItem } from './meeting-types'

/** Correct generated references together with speaker labels, including simultaneous Speaker N renumbering. */
export function relabelMeetingNotes(
  notes: MeetingNotes | null, before: MeetingSpeaker[], after: MeetingSpeaker[]
): MeetingNotes | null {
  if (!notes) return null
  const next = new Map(after.map(s => [s.key, s.label]))
  const targets = new Map<string, Set<string>>()
  for (const s of before) {
    const label = next.get(s.key)
    if (!label) continue
    const names = targets.get(s.label) ?? new Set<string>()
    names.add(label)
    targets.set(s.label, names)
  }
  const replacements = new Map([...targets].flatMap(([from, names]) =>
    from && names.size === 1 && !names.has(from) ? [[from, [...names][0]] as const] : []))
  if (!replacements.size) return notes
  const escaped = [...replacements.keys()].sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'gu')
  let changed = false
  const replace = (s: string): string => s.replace(pattern, name => { changed = true; return replacements.get(name)! })
  const item = (n: NoteItem): NoteItem => {
    const text = replace(n.text)
    const owner = n.owner == null ? n.owner : replace(n.owner)
    if (text === n.text && owner === n.owner) return n
    const { confidence: _confidence, ...rest } = n
    return { ...rest, text, ...(n.owner !== undefined ? { owner } : {}), verification: 'unverified' }
  }
  const result = { ...notes, ...(notes.title ? { title: replace(notes.title) } : {}), summary: notes.summary.map(replace),
    decisions: notes.decisions.map(item), actionItems: notes.actionItems.map(item), openQuestions: notes.openQuestions.map(item) }
  return changed ? { ...result, verifiedBy: null } : notes
}
