import type { HelperMeetCall, MeetingParticipant, MeetingSpeaker } from './meeting-types'

/** Only semantic control labels from a Meet document; never chat, captions or general page text. */
export function parseMeetControls(appPid: number, exe: string, title: string, controls: string[]): HelperMeetCall {
  const labels = controls.map(s => s.replace(/\s+/g, ' ').trim())
  const joined = labels.some(s => /^Leave (?:call|meeting)(?:\s*\(.*\))?$/i.test(s))
  const left = labels.some(s => /^(?:Rejoin|Join now|Ask to join|Return to home screen)$/i.test(s))
  const participants: string[] = []
  let participantCount: number | null = null
  for (const label of labels) {
    const match = /^More (?:options|actions) for (.{1,120})$/i.exec(label)
    if (match) {
      const name = match[1].trim()
      if (!/^(?:you|your presentation|the meeting)$/i.test(name) && !/\(you\)$|\bpresentation\b/i.test(name) &&
          !participants.some(p => p.toLowerCase() === name.toLowerCase())) participants.push(name)
    }
    const count = /^(?:Show everyone|People|Participants|In (?:this )?call)\s*\((\d{1,4})\)$/i.exec(label)
    if (count) participantCount = Math.max(participantCount ?? 0, Number(count[1]))
  }
  const micMuted = labels.some(s => /^Turn on microphone\b/i.test(s)) ? true
    : labels.some(s => /^Turn off microphone\b/i.test(s)) ? false : null
  return { appPid, exe, title, state: left ? 'left' : joined ? 'joined' : 'unknown',
    participants, participantCount, micMuted }
}

export function meetParticipants(call: HelperMeetCall): MeetingParticipant[] {
  return call.participants.map(name => ({ name, email: null, source: 'meet',
    rosterComplete: call.participantCount !== null && call.participants.length === call.participantCount - 1 }))
}

/** Union across the call. A partial roster must never be mistaken for an exclusive 1:1 call. */
export function mergeParticipants(previous: MeetingParticipant[], observed: MeetingParticipant[]): MeetingParticipant[] {
  const all = [...previous]
  for (const person of observed) {
    const index = all.findIndex(p => p.name.toLowerCase() === person.name.toLowerCase())
    if (index < 0) all.push(person)
    else if (all[index].source === 'meet') all[index] = { ...person,
      rosterComplete: all[index].rosterComplete === true && person.rosterComplete === true }
  }
  return all
}

export function authoritativeParticipants(people: MeetingParticipant[]): MeetingParticipant[] {
  return people.every(p => p.source === 'user' || (p.source === 'meet' && p.rosterComplete === true)) ? people : []
}

/** Match the configured local display name; a shared first name does not identify the local user. */
export function withoutSelfParticipant(people: MeetingParticipant[], userName: string): MeetingParticipant[] {
  const self = userName.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  if (!self) return people
  return people.filter(p => p.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase() !== self)
}

export function participantLabels(speakers: MeetingSpeaker[], participants: MeetingParticipant[]): string[] {
  const voices = [...speakers].sort((a, b) => b.seconds - a.seconds)
  participants = withoutSelfParticipant(participants, speakers.find(s => s.source === 'self')?.label ?? '')
  const names = [...voices.filter(s => s.source !== 'unknown' || !participants.length).map(s => s.label),
    ...participants.map(p => p.name)]
  return names.filter((name, i) => names.findIndex(n => n.toLowerCase() === name.toLowerCase()) === i)
}
