export type TranscriptGrade = 'clean' | 'suspicious' | 'reject'
export type CandidateSource = 'remote-primary' | 'remote-recovery' | 'native' | 'adjudicated'

export interface TranscriptAssessment {
  grade: TranscriptGrade
  score: number
  reasons: string[]
}

export interface TranscriptCandidate {
  source: CandidateSource
  text: string
  elapsedMs: number
}

export interface QualityOptions {
  language: 'en'
  glossary?: string[]
}

const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}])'
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}])'

const SOURCE_PRIORITY: Record<CandidateSource, number> = {
  adjudicated: 0,
  native: 1,
  'remote-primary': 2,
  'remote-recovery': 3
}

const FUNCTION_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'not',
  'of',
  'on',
  'or',
  'our',
  'out',
  'she',
  'should',
  'that',
  'the',
  'their',
  'them',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'up',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your'
])

const QUESTION_LEADERS = new Set(['how', 'what', 'why', 'when', 'where'])
const AUXILIARIES = new Set(['can', 'could', 'did', 'do', 'does', 'should', 'will', 'would'])
const PRONOUNS = new Set(['he', 'i', 'it', 'she', 'they', 'we', 'you'])
const BARE_VERBS = new Set([
  'ask',
  'build',
  'call',
  'change',
  'deploy',
  'figure',
  'find',
  'fix',
  'force',
  'get',
  'go',
  'keep',
  'make',
  'move',
  'open',
  'push',
  'run',
  'send',
  'set',
  'show',
  'start',
  'stop',
  'take',
  'turn',
  'use',
  'work',
  'write'
])
const PARTICLES = new Set(['away', 'back', 'down', 'in', 'off', 'on', 'out', 'over', 'up'])

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function glossaryPattern(term: string): RegExp {
  const tokens = term.trim().split(/\s+/).map(escapeRegex)
  return new RegExp(BOUNDARY_BEFORE + tokens.join('\\s+') + BOUNDARY_AFTER, 'giu')
}

function stripGlossary(text: string, glossary: string[] = []): string {
  let out = text
  for (const term of glossary) {
    const trimmed = term.trim()
    if (!trimmed) continue
    out = out.replace(glossaryPattern(trimmed), ' ')
  }
  return out
}

function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}']+/gu) ?? []
}

function countFunctionWords(tokens: string[]): number {
  let count = 0
  for (const token of tokens) {
    if (FUNCTION_WORDS.has(token.toLowerCase())) count++
  }
  return count
}

function hasAssistantReply(text: string): boolean {
  const wrapperPattern =
    /^\s*(?:(?:sure|certainly|absolutely|of course)[,:]?\s*)?(?:here(?:'s| is)\s+(?:the\s+)?(?:(?:cleaned|corrected|revised)\s+)?(?:transcript|transcription|result)\b|here(?:'s| is)\s+(?:the\s+)?(?:final\s+)?version\b|(?:cleaned|corrected|revised)\s+transcript\b|transcript:|transcription:|result:|version:)/iu
  if (wrapperPattern.test(text)) return true

  return /^\s*(?:you'?re welcome\b|let me know if\b|how can i help\b|how may i help\b|i can help\b|i can assist\b|happy to help\b|i'?d be happy to\b|sure[,! ]+i can\b|of course[,! ]+i can\b|certainly[,! ]+i can\b)/iu.test(
    text
  )
}

function hasExtendedLatinReject(text: string): boolean {
  const tokenList = words(text)
  let lowercaseAccentedTokens = 0
  let totalExtendedLatinLetters = 0

  for (const token of tokenList) {
    let tokenExtendedLatinLetters = 0
    for (const char of token) {
      if (!/\p{L}/u.test(char)) continue
      if (!/[^\x00-\x7F]/.test(char)) continue
      tokenExtendedLatinLetters++
    }
    if (!tokenExtendedLatinLetters) continue

    totalExtendedLatinLetters += tokenExtendedLatinLetters
    if (/^\p{Ll}/u.test(token)) lowercaseAccentedTokens++
  }

  return lowercaseAccentedTokens >= 2 && totalExtendedLatinLetters >= 3
}

function hasDecoderGarbage(text: string): boolean {
  const tokenList = words(text).map((token) => token.toLowerCase())
  if (tokenList.length < 4) return false

  let repeatedRun = 1
  for (let i = 1; i < tokenList.length; i++) {
    repeatedRun = tokenList[i] === tokenList[i - 1] ? repeatedRun + 1 : 1
    if (repeatedRun >= 3) return true
  }

  const counts = new Map<string, number>()
  for (const token of tokenList) counts.set(token, (counts.get(token) ?? 0) + 1)
  return Math.max(...counts.values()) >= Math.ceil(tokenList.length / 2) + 1
}

function hasBrokenQuestionPattern(text: string): boolean {
  if (!text.trim().endsWith('?')) return false
  const tokenList = words(text).map((token) => token.toLowerCase())
  if (tokenList.length < 6) return false
  if (!QUESTION_LEADERS.has(tokenList[0])) return false
  if (!AUXILIARIES.has(tokenList[1])) return false
  if (!PRONOUNS.has(tokenList[2])) return false

  const tail = tokenList.slice(3)
  if (tail.length < 3) return false
  if (!tail.every((token) => BARE_VERBS.has(token) || PARTICLES.has(token))) return false

  for (let i = 1; i < tail.length; i++) {
    if (BARE_VERBS.has(tail[i - 1]) && BARE_VERBS.has(tail[i])) return true
  }
  return false
}

function hasLowEnglishEvidence(text: string): boolean {
  const tokenList = words(text)
  if (tokenList.length < 6) return false
  const functionWordCount = countFunctionWords(tokenList)
  let technicalTokenCount = 0

  for (const token of tokenList) {
    if (/[A-Z]/.test(token) || /\d/.test(token)) technicalTokenCount++
  }

  return functionWordCount === 0 && technicalTokenCount < 2
}

export function assessTranscript(text: string, options: QualityOptions): TranscriptAssessment {
  const trimmed = text.trim()
  const glossaryStripped = stripGlossary(trimmed, options.glossary)
  const rejectReasons: string[] = []
  const suspiciousReasons: string[] = []

  if (!trimmed || !/[\p{L}\p{N}]/u.test(trimmed)) rejectReasons.push('empty')
  if (/[ðþÐÞ]/u.test(glossaryStripped)) rejectReasons.push('forbidden-script')
  if (hasAssistantReply(trimmed)) rejectReasons.push('assistant-reply')
  if (hasExtendedLatinReject(glossaryStripped)) rejectReasons.push('extended-latin')
  if (hasDecoderGarbage(glossaryStripped)) rejectReasons.push('decoder-garbage')

  if (!rejectReasons.length) {
    if (hasBrokenQuestionPattern(trimmed)) suspiciousReasons.push('broken-question')
    if (hasLowEnglishEvidence(glossaryStripped)) suspiciousReasons.push('low-english-evidence')
  }

  if (rejectReasons.length) return { grade: 'reject', score: 0, reasons: rejectReasons }
  if (suspiciousReasons.length) {
    return {
      grade: 'suspicious',
      score: Math.max(1, 70 - suspiciousReasons.length * 10),
      reasons: suspiciousReasons
    }
  }
  return { grade: 'clean', score: 100, reasons: [] }
}

export function chooseTranscript(
  candidates: TranscriptCandidate[],
  options: QualityOptions
): TranscriptCandidate | null {
  const ranked = candidates.map((candidate, index) => ({
    candidate,
    assessment: assessTranscript(candidate.text, options),
    index
  }))

  const viable = ranked.filter(({ assessment }) => assessment.grade !== 'reject')
  if (!viable.length) return null

  viable.sort(
    (a, b) =>
      b.assessment.score - a.assessment.score ||
      SOURCE_PRIORITY[a.candidate.source] - SOURCE_PRIORITY[b.candidate.source] ||
      a.index - b.index
  )

  return viable[0].candidate
}
