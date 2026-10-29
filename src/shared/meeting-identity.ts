import { authoritativeParticipants } from './meet-controls'
import { DEFAULT_NAMING, nameSpeakers, numberUnknown, type SpeakerEvidence, type VoiceprintCandidate } from './meeting-speakers'
import type { MeetingAppId, MeetingParticipant, MeetingSpeaker } from './meeting-types'

/** Legacy inferred labels must not survive as asserted identities when a reprocess fails. */
export function retireUnverifiedNames(speakers: MeetingSpeaker[], participants: MeetingParticipant[]): MeetingSpeaker[] {
  const verified = authoritativeParticipants(participants)
  const remoteCount = speakers.filter(s => s.key.startsWith('others')).length
  return numberUnknown(speakers.map(s => {
    const unsupported = s.source === 'hint' || s.source === 'calendar' ||
      (s.source === 'voiceprint' && (s.personId == null || (s.score ?? 0) < DEFAULT_NAMING.accept)) ||
      (s.source === 'meet' && !(remoteCount === 1 && verified.length === 1 &&
        verified[0].source === 'meet' && verified[0].name.trim().toLowerCase() === s.label.trim().toLowerCase()))
    return unsupported ? { ...s, source: 'unknown' as const, suggestion: s.suggestion ?? s.label, personId: null, score: null } : s
  })).map(s => s.key === 'others' && s.source === 'unknown' ? { ...s, label: 'Others' } : s)
}

/** Attendance can identify a sole remote voice only when observed in-call or confirmed by the user. */
export function applyParticipantNames(speakers: MeetingSpeaker[], participants: MeetingParticipant[]): MeetingSpeaker[] {
  const verified = authoritativeParticipants(participants)
  const remote = speakers.filter(s => s.key.startsWith('others'))
  if (verified.length !== 1 || remote.length !== 1) return speakers
  return numberUnknown(speakers.map(s => s === remote[0] && s.source === 'unknown'
    ? { ...s, label: verified[0].name, source: verified[0].source!, suggestion: null, score: null, personId: null }
    : s))
}

/** Conversation evidence remains a proposal; mentioning an attendee does not prove who spoke. */
export function applyConversationSuggestions(
  speakers: MeetingSpeaker[], proposals: Array<{ speaker: string; name: string }>, participants: MeetingParticipant[]
): MeetingSpeaker[] {
  const normalized = (s: string): string => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  return speakers.map(s => {
    if (s.source !== 'unknown' || s.suggestion) return s
    const proposal = proposals.find(p => p.speaker === s.label)
    if (!proposal) return s
    const name = normalized(proposal.name)
    const exact = participants.filter(p => normalized(p.name) === name)
    const firstOnly = !name.includes(' ') ? participants.filter(p => normalized(p.name).split(' ')[0] === name) : []
    const matches = exact.length ? exact : firstOnly
    return { ...s, suggestion: matches.length === 1 ? matches[0].name : proposal.name }
  })
}

/** Reprocessing can renumber voices. Restore an explicit correction using the saved voice, never a speaker key alone. */
export function restoreConfirmedNames(
  speakers: MeetingSpeaker[], evidence: SpeakerEvidence[],
  saved: Array<{ speaker: MeetingSpeaker; embedding: number[] }>, app: MeetingAppId
): MeetingSpeaker[] {
  const people: VoiceprintCandidate[] = []
  const originals = new Map<number, MeetingSpeaker>()
  for (const { speaker, embedding } of saved) {
    if (speaker.source !== 'user' || speaker.key === 'me' || speaker.seconds < 10 || !embedding.length) continue
    let person = people.find(p => p.name.trim().toLowerCase() === speaker.label.trim().toLowerCase())
    if (!person) {
      person = { personId: -(people.length + 1), name: speaker.label, exemplars: [] }
      people.push(person)
      originals.set(person.personId, speaker)
    }
    person.exemplars.push({ embedding, sourceApp: app })
  }
  if (!people.length) return speakers
  const matches = nameSpeakers(evidence, people, [], app, { ...DEFAULT_NAMING, userName: '', accept: 0.8, margin: 0.15 })
  return numberUnknown(speakers.map(s => {
    const match = matches.find(m => m.key === s.key && m.source === 'voiceprint')
    const original = match?.personId != null ? originals.get(match.personId) : undefined
    return original ? { ...s, label: original.label, source: 'user', personId: original.personId, suggestion: null, score: null } : s
  }))
}
