import type { MeetingParticipant } from './meeting-types'
import type { DictionaryEntry } from './types'

// The keyword list for a meeting's final pass. Granite Speech biases its transcript toward a
// `Keywords: a, b, c` list in its prompt, which is how "zebra" becomes Zeltra and "brocksa" BROXA. The
// list is words Echo already trusts: this meeting's people, remembered voices, and the user's
// dictionary. Models that do not use a prompt ignore it.

/**
 * Granite was trained with lists of 1 to 200 words, and shorter lists recognise the listed words
 * better (arXiv 2604.12398: 3.2% vs 4.4% bias-word WER at 10 vs 200), so stay well inside that.
 */
export const MAX_MEETING_KEYWORDS = 100
/** One keyword longer than this is a phrase or a paste, not a term worth biasing toward. */
const MAX_KEYWORD_CHARS = 60

export interface MeetingKeywordSources {
  /** `meetingUserName`, or the OS account name. */
  userName: string
  /** The calendar event's other attendees. */
  participants: MeetingParticipant[]
  /** Names the meeting app showed (a Slack huddle's title, a Teams window). */
  nameHints: string[]
  /** Everyone in the voiceprint library. */
  people: string[]
  dictionary: DictionaryEntry[]
}

/**
 * Deduplicated keywords, most specific to this meeting first: the user, the attendees and name
 * hints, remembered voices, then dictionary words (most used, then newest; canonical spellings
 * only, since an alias would bias toward the wrong spelling). Capped at `max`.
 */
export function meetingKeywords(sources: MeetingKeywordSources, max = MAX_MEETING_KEYWORDS): string[] {
  const words = [...sources.dictionary]
    .sort((a, b) => b.times_applied - a.times_applied || b.created_at - a.created_at)
    .map((e) => e.word)
  const ordered = [
    sources.userName,
    ...sources.participants.map((p) => p.name),
    ...sources.nameHints,
    ...sources.people,
    ...words
  ]
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of ordered) {
    if (out.length >= max) break
    const word = raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
    const key = word.toLowerCase()
    if (!word || word.length > MAX_KEYWORD_CHARS || /^speaker \d+$/.test(key) || seen.has(key)) continue
    seen.add(key)
    out.push(word)
  }
  return out
}

/** The `prompt` form field for the segments route: the keywords as a comma list. */
export function meetingKeywordPrompt(keywords: string[]): string {
  return keywords.join(', ')
}
