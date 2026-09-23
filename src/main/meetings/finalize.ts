import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyDictionary } from '@shared/dictionary'
import { int16ToWav, isSilentChunk, planLiveCut, speechSeconds } from '@shared/meeting-audio'
import { renderMarkdown, meetingFileName } from '@shared/meeting-export'
import { DEFAULT_NAMING, nameSpeakers, numberUnknown, type SpeakerEvidence } from '@shared/meeting-speakers'
import { mergeSpeakers } from '@shared/meeting-diarization'
import { meetingKeywordPrompt, meetingKeywords } from '@shared/meeting-keywords'
import { correctNames } from '@shared/name-correction'
import { transplantVocabulary } from '@shared/vocab-transplant'
import {
  batchSegments,
  buildAsrSegments,
  chooseSegmentText,
  dropMicBleed,
  filterMicSegments,
  isFillerOnly,
  mergeUtterances,
  punctuateFromCheck,
  selfSpeakerLabel
} from '@shared/meeting-transcript'
import {
  MEETING_APP_LABELS,
  MEETING_SAMPLE_RATE,
  OTHERS_SPEAKER_KEY,
  SELF_SPEAKER_KEY,
  type AsrSegment,
  type DiarizationResult,
  type DiarizedTurn,
  type MeetingChannel,
  type MeetingNotes,
  type MeetingParticipant,
  type MeetingRecord,
  type MeetingSegment,
  type MeetingSpeaker,
  type MeetingUtterance,
  type SegmentTranscript
} from '@shared/meeting-types'
import type { DictionaryEntry, Secrets, Settings } from '@shared/types'
import type { MeetingPatch, MeetingsStore } from '../store/meetings'
import type { VoiceprintStore } from '../store/voiceprints'
import { draftNotes, type NotesConfig, type NotesMeta, type NotesUtterance } from './notes'
import { suggestSpeakerNames, type SpeakerNameProposal } from './speaker-names'
import { readMicPauses, readPcmFile, silenceMicPauses } from './pcm-file'
import { diarize, SpeechRouteError, transcribeSegments, type SpeechConn } from './speech-client'
import { typesafeClient, verifyNotes } from './typesafe'

// The final pass after a meeting ends: diarize both channels on the GB10, decode speaker-homogeneous
// segments with the most accurate model (cross-checked by a second), name the speakers, draft and
// verify notes, and write the .md. Every step reports progress on the meeting row. Losing the
// diarizer degrades to one speaker per channel; losing notes or verification still ships the
// transcript. Spec: "Final pass".

export const INTERRUPTED_ERROR = 'Recording was interrupted before any audio was saved'
export const AUDIO_DELETED_ERROR = 'Audio was already deleted'

/** Speech a channel needs before it is worth diarizing (and transcribing at all). */
const MIN_CHANNEL_SPEECH_S = 1
/** Voiceprint auto-matches at least this strong are enrolled as another exemplar. */
const AUTO_ENROL_SCORE = 0.75
/** The shim accepts at most 400 segments per request; stay well under it. */
const MAX_SEGMENTS_PER_REQUEST = 200
/** Same-speaker turns join into utterances of at most this long. */
const MAX_UTTERANCE_MS = 60_000
/** A clip with less speech than this (a click, a breath) is not sent: models invent words for it. */
const MIN_CLIP_SPEECH_S = 0.06

export interface FinalizeSpeech {
  diarize: (wav: ArrayBuffer, opts: { maxSpeakers: number }, conn: SpeechConn) => Promise<DiarizationResult>
  transcribeSegments: (
    wav: ArrayBuffer,
    segments: Array<{ id: string; start: number; end: number }>,
    models: string[],
    conn: SpeechConn,
    /** Keywords (comma list) for the models that take a prompt. */
    prompt?: string
  ) => Promise<SegmentTranscript[]>
}

export interface FinalizeNotes {
  draft: (meta: NotesMeta, utterances: NotesUtterance[], config: NotesConfig, apiKey: string) => Promise<MeetingNotes>
  verify: (notes: MeetingNotes, utterances: NotesUtterance[], typesafeKey: string) => Promise<MeetingNotes>
}

export interface FinalizeDeps {
  meetings: MeetingsStore
  voiceprints: VoiceprintStore
  settings: () => Settings
  secrets: () => Secrets
  dictionary: () => DictionaryEntry[]
  /** userData/meetings: holds each meeting's audio directory and its `<uuid>.speakers.json`. */
  meetingsDir: string
  /** The .md folder when `meetingOutputDir` is empty (Documents\Echo Meetings). */
  defaultOutputDir: () => string
  /** The OS account name, used when `meetingUserName` is empty. */
  osUserName: () => string
  speech?: FinalizeSpeech
  notes?: FinalizeNotes
  /** The user's calendar: who else attended (null: no calendar, or no matching event). */
  calendar?: {
    participants(
      meeting: { app: MeetingRecord['app']; title: string | null; startedAt: number },
      self: { name: string; email: string }
    ): Promise<MeetingParticipant[] | null>
  }
  /** Names for unnamed speakers from what was said (default: one small Claude call). */
  speakerNames?: (
    utterances: NotesUtterance[],
    unnamed: string[],
    candidates: string[],
    config: NotesConfig,
    apiKey: string
  ) => Promise<SpeakerNameProposal[]>
  notify: (n: { kind: 'notes-ready' | 'notes-failed'; title: string; body: string; meetingId: number }) => void
  /** A meeting row changed (progress, status, transcript). */
  updated: (meetingId: number) => void
  /** Diagnostic log; never given titles, names or transcript text. */
  log: (message: string) => void
}

const defaultSpeech: FinalizeSpeech = {
  diarize: (wav, opts, conn) => diarize(wav, opts, conn),
  transcribeSegments: (wav, segments, models, conn, prompt) => transcribeSegments(wav, segments, models, conn, undefined, prompt)
}

const defaultNotes: FinalizeNotes = {
  draft: (meta, utterances, config, apiKey) => draftNotes(meta, utterances, config, apiKey),
  verify: (notes, utterances, key) => verifyNotes(notes, utterances, typesafeClient(key))
}

/** Per-speaker voice data kept next to (not inside) the audio directory, so retention keeps it. */
export interface SpeakersFile {
  embeddingModel: string | null
  speakers: Array<{ key: string; seconds: number; embedding: number[] | null }>
}

export function speakersFilePath(meetingsDir: string, uuid: string): string {
  return join(meetingsDir, `${uuid}.speakers.json`)
}

export function readSpeakersFile(meetingsDir: string, uuid: string): SpeakersFile | null {
  try {
    const parsed = JSON.parse(readFileSync(speakersFilePath(meetingsDir, uuid), 'utf8')) as SpeakersFile
    return parsed && Array.isArray(parsed.speakers) ? parsed : null
  } catch {
    return null
  }
}

/** Transcript utterances from stored segments, in transcript order. */
export function utterancesOf(segments: MeetingSegment[]): MeetingUtterance[] {
  return [...segments]
    .sort((a, b) => a.idx - b.idx)
    .map((s) => ({ start: s.start_ms, end: s.end_ms, channel: s.channel, speakerKey: s.speaker_key, text: s.text }))
}

/** The folder the .md copies go to. */
export function outputDirFor(settings: Settings, defaultOutputDir: () => string): string {
  return settings.meetingOutputDir.trim() || defaultOutputDir()
}

/**
 * Write the meeting's .md into `dir`, reusing `previous` when it is the same file name (a
 * reprocess or a rename) and otherwise appending ' (2)', ' (3)', … on a clash. Returns the path.
 */
export function writeMeetingMarkdown(rec: MeetingRecord, segments: MeetingSegment[], dir: string): string {
  mkdirSync(dir, { recursive: true })
  const name = meetingFileName({ app: rec.app, title: rec.title, startedAt: rec.started_at }, 'md')
  const stem = name.slice(0, -'.md'.length)
  let path = join(dir, name)
  for (let n = 2; existsSync(path) && path !== rec.output_path; n++) path = join(dir, `${stem} (${n}).md`)
  const markdown = renderMarkdown({
    app: rec.app,
    title: rec.title,
    startedAt: rec.started_at,
    endedAt: rec.ended_at,
    speakers: rec.speakers,
    notes: rec.notes,
    utterances: utterancesOf(segments)
  })
  writeFileSync(path, markdown, 'utf8')
  return path
}

/** Thrown when the meeting row disappears mid-pass (the user deleted it): stop quietly. */
class MeetingGone extends Error {}

/** A short, content-free reason for the meeting's error field. */
function failureReason(e: unknown): string {
  if (e instanceof SpeechRouteError) return truncate(`The speech server could not finish the transcript. ${e.message}`)
  const message = e instanceof Error ? e.message : String(e)
  return truncate(`Couldn't finish the meeting notes. ${message}`)
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function describeError(e: unknown): string {
  const err = e as { name?: string; status?: number }
  return `${err?.name ?? 'Error'}${err?.status ? ` ${err.status}` : ''}`
}

/**
 * The diarizer is missing or down (404, 5xx, network, timeout, or a malformed answer from a
 * half-deployed server): transcribe without speaker separation. An auth or request error (other
 * 4xx) is a real failure that the transcription step would hit too.
 */
function diarizerUnavailable(e: unknown): boolean {
  if (!(e instanceof SpeechRouteError)) return false
  return e.status === undefined || e.status === 404 || e.status >= 500
}

/** Pause-cut segments (≤ 30 s, silent stretches skipped) of one channel, all one speaker. */
export function pauseSegments(samples: Int16Array, speaker: string, idPrefix: string): AsrSegment[] {
  const out: AsrSegment[] = []
  const maxSamples = 30 * MEETING_SAMPLE_RATE
  let pos = 0
  while (pos < samples.length) {
    const rest = samples.subarray(pos)
    const cut = rest.length <= maxSamples ? rest.length : planLiveCut(rest, false) ?? rest.length
    const chunk = rest.subarray(0, Math.max(1, cut))
    if (!isSilentChunk(chunk)) {
      out.push({
        id: `${idPrefix}${out.length}`,
        start: pos / MEETING_SAMPLE_RATE,
        end: (pos + chunk.length) / MEETING_SAMPLE_RATE,
        speaker
      })
    }
    pos += chunk.length
  }
  return out
}

interface ChannelPlan {
  channel: MeetingChannel
  samples: Int16Array
  /** Segments whose `speaker` is already the final speaker key. */
  segments: AsrSegment[]
  /** Per speaker key: diarized speech seconds and embedding. */
  voices: Map<string, { seconds: number; embedding: number[] | null }>
  diarization: DiarizationResult | null
}

/** Run the whole final pass for one meeting. Never throws; the row ends `ready` or `failed`. */
export async function finalizeMeeting(meetingId: number, deps: FinalizeDeps): Promise<void> {
  const speech = deps.speech ?? defaultSpeech
  const notesApi = deps.notes ?? defaultNotes
  const update = (patch: MeetingPatch): MeetingRecord => {
    const row = deps.meetings.update(meetingId, patch)
    if (!row) throw new MeetingGone()
    deps.updated(meetingId)
    return row
  }
  const step = (progress: string): MeetingRecord => update({ progress })

  try {
    let rec = deps.meetings.get(meetingId)
    if (!rec) return
    rec = update({ status: 'processing', error: null, progress: 'Preparing audio' })
    const settings = deps.settings()
    const secrets = deps.secrets()
    const conn: SpeechConn = { baseUrl: settings.whisperBaseUrl, apiKey: secrets.whisperApiKey }

    // 1. Preparing audio
    if (!rec.audio_dir || !existsSync(rec.audio_dir)) throw new Error(AUDIO_DELETED_ERROR)
    const mic = readPcmFile(join(rec.audio_dir, 'mic.pcm'))
    // The helper already wrote silence while the mic was paused; also silence the moment before
    // each pause (an app's mute is noticed late), and any span it could not pause in time.
    silenceMicPauses(mic, readMicPauses(rec.audio_dir))
    const others = readPcmFile(join(rec.audio_dir, 'others.pcm'))
    if (mic.length === 0 && others.length === 0) throw new Error(INTERRUPTED_ERROR)
    const totalS = Math.max(mic.length, others.length) / MEETING_SAMPLE_RATE
    if (rec.ended_at === null) rec = update({ ended_at: rec.started_at + Math.round(totalS * 1000) })
    const userName = settings.meetingUserName.trim() || deps.osUserName()
    // The calendar event's other attendees, when there is a calendar and the meeting matches one.
    if (rec.participants.length === 0 && deps.calendar) {
      const found = await deps.calendar.participants(
        { app: rec.app, title: rec.title, startedAt: rec.started_at },
        { name: userName, email: settings.meetingMyEmail }
      )
      if (found?.length) rec = update({ participants: found })
    }
    const participants = rec.participants

    // 2. Separating speakers
    step('Separating speakers')
    const tryDiarize = async (samples: Int16Array, maxSpeakers: number, channel: MeetingChannel) => {
      try {
        return await speech.diarize(int16ToWav(samples), { maxSpeakers }, conn)
      } catch (e) {
        if (!diarizerUnavailable(e)) throw e
        deps.log(`final pass: diarizer unavailable for ${channel} (${describeError(e)}); one speaker per channel`)
        return null
      }
    }
    const othersSpoke = others.length > 0 && speechSeconds(others) >= MIN_CHANNEL_SPEECH_S
    const micSpoke = mic.length > 0 && speechSeconds(mic) >= MIN_CHANNEL_SPEECH_S
    const othersRaw = othersSpoke ? await tryDiarize(others, 8, 'others') : null
    const micRaw = micSpoke ? await tryDiarize(mic, 4, 'mic') : null
    // Over-split speakers merge: a backchannel-only cluster into the voice it belongs to, and
    // everyone on the others channel into one when the calendar says one other person attended.
    const merged = (raw: DiarizationResult | null, channel: MeetingChannel, expected?: number): DiarizationResult | null => {
      if (!raw) return null
      const { result, merges } = mergeSpeakers(raw, { expectedSpeakers: expected })
      for (const m of merges) {
        deps.log(`final pass: merged a ${channel} speaker (${m.reason}${m.cosine === null ? '' : `, cosine ${m.cosine}`})`)
      }
      return result
    }
    const othersDiar = merged(othersRaw, 'others', participants.length === 1 ? 1 : undefined)
    const micDiar = merged(micRaw, 'mic')

    const plans: ChannelPlan[] = []
    let othersTurns: DiarizedTurn[] = []
    if (othersSpoke) {
      const plan: ChannelPlan = { channel: 'others', samples: others, segments: [], voices: new Map(), diarization: othersDiar }
      if (othersDiar) {
        const key = (label: string): string => `others:${label}`
        othersTurns = othersDiar.segments
        plan.segments = buildAsrSegments(othersDiar.segments, others, totalS, 'o').map((s) => ({ ...s, speaker: key(s.speaker) }))
        for (const s of othersDiar.speakers) plan.voices.set(key(s.id), { seconds: s.speechSeconds, embedding: s.embedding })
      } else {
        plan.segments = pauseSegments(others, OTHERS_SPEAKER_KEY, 'o')
        othersTurns = plan.segments.map((s) => ({ start: s.start, end: s.end, speaker: OTHERS_SPEAKER_KEY }))
      }
      plans.push(plan)
    }
    if (micSpoke) {
      const plan: ChannelPlan = { channel: 'mic', samples: mic, segments: [], voices: new Map(), diarization: micDiar }
      if (micDiar) {
        const self = selfSpeakerLabel(micDiar)
        const key = (label: string): string => (label === self ? SELF_SPEAKER_KEY : `mic:${label}`)
        // 3. The mic's main voice is the user; other mic voices mostly under remote speech are bleed.
        const segments = filterMicSegments(buildAsrSegments(micDiar.segments, mic, totalS, 'm'), self, othersTurns)
        plan.segments = segments.map((s) => ({ ...s, speaker: key(s.speaker) }))
        for (const s of micDiar.speakers) plan.voices.set(key(s.id), { seconds: s.speechSeconds, embedding: s.embedding })
      } else {
        plan.segments = pauseSegments(mic, SELF_SPEAKER_KEY, 'm')
      }
      plans.push(plan)
    }

    // 4. Transcribing
    const models = [...new Set([settings.meetingFinalModel, settings.meetingCheckModel].map((m) => m.trim()).filter(Boolean))]
    if (!models.length) throw new Error('No meeting transcription model is configured')
    // The keyword-biased model decodes the same clips concurrently; only its spelling of listed
    // terms is borrowed. Off when unset or already the primary (its text is the transcript then).
    const vocabModel = settings.meetingVocabModel.trim()
    let vocabOn = Boolean(vocabModel) && vocabModel !== settings.meetingFinalModel.trim()
    for (const plan of plans) {
      const before = plan.segments.length
      plan.segments = plan.segments.filter((s) => {
        const clip = plan.samples.subarray(Math.floor(s.start * MEETING_SAMPLE_RATE), Math.ceil(s.end * MEETING_SAMPLE_RATE))
        return speechSeconds(clip) >= MIN_CLIP_SPEECH_S
      })
      if (plan.segments.length < before) deps.log(`final pass: skipped ${before - plan.segments.length} ${plan.channel} clip(s) with no speech`)
    }
    const jobs = plans.flatMap((plan) => splitBatches(batchSegments(plan.segments)).map((batch) => ({ plan, batch })))
    let dict: DictionaryEntry[] = []
    try {
      dict = deps.dictionary()
    } catch {
      /* the transcript works without the dictionary */
    }
    // Words to bias the models toward: this meeting's people, remembered voices, the dictionary.
    const keywords = meetingKeywords({
      userName,
      participants,
      nameHints: rec.name_hints,
      people: deps.voiceprints.people().map((p) => p.name),
      dictionary: dict
    })
    const prompt = meetingKeywordPrompt(keywords)
    deps.log(`final pass: ${keywords.length} keyword(s) for the transcription models`)
    const utterances: MeetingUtterance[] = []
    let swapped = 0
    for (const [n, { plan, batch }] of jobs.entries()) {
      step(`Transcribing (${n + 1}/${jobs.length})`)
      const from = Math.floor(batch.start * MEETING_SAMPLE_RATE)
      const to = Math.min(plan.samples.length, Math.ceil(batch.end * MEETING_SAMPLE_RATE))
      const wav = int16ToWav(plan.samples.subarray(from, to))
      const offset = from / MEETING_SAMPLE_RATE
      const rebased = batch.segments.map((s) => ({
        id: s.id,
        start: Math.max(0, round3(s.start - offset)),
        end: Math.min(round3((to - from) / MEETING_SAMPLE_RATE), round3(s.end - offset))
      }))
      const withVocab = vocabOn && !models.includes(vocabModel) ? [...models, vocabModel] : models
      let results: SegmentTranscript[]
      try {
        results = await speech.transcribeSegments(wav, rebased, withVocab, conn, prompt)
      } catch (e) {
        if (withVocab === models) throw e
        // The vocabulary model is an extra: the transcript never waits on it or fails for it.
        deps.log(`final pass: vocabulary model failed (${describeError(e)}); continuing without it`)
        vocabOn = false
        results = await speech.transcribeSegments(wav, rebased, models, conn, prompt)
      }
      const texts = new Map(results.map((r) => [r.id, r.texts]))
      for (const s of batch.segments) {
        const clip = texts.get(s.id) ?? {}
        let chosen = chooseSegmentText(clip, settings.meetingFinalModel, settings.meetingCheckModel, s.end - s.start).trim()
        if (vocabOn && chosen && clip[vocabModel]) {
          const transplant = transplantVocabulary(chosen, clip[vocabModel], keywords)
          chosen = transplant.text
          swapped += transplant.swaps.length
        }
        let text = punctuateFromCheck(chosen, clip[settings.meetingCheckModel] ?? '')
        if (text) text = applyDictionary(text, dict).text.trim()
        if (!text || isFillerOnly(text)) continue
        utterances.push({
          start: Math.round(s.start * 1000),
          end: Math.round(s.end * 1000),
          channel: plan.channel,
          speakerKey: s.speaker,
          text
        })
      }
    }

    if (swapped) deps.log(`final pass: ${swapped} word(s) spelt as the vocabulary model heard them`)

    // 6 (before naming, so only speakers who still say something are named). Bleed out, merge.
    const finalUtterances = mergeUtterances(dropMicBleed(utterances), undefined, MAX_UTTERANCE_MS)

    // 5. Naming speakers
    step('Naming speakers')
    const embeddingModel = othersDiar?.embeddingModel ?? micDiar?.embeddingModel ?? null
    const evidence: SpeakerEvidence[] = []
    for (const u of finalUtterances) {
      if (evidence.some((e) => e.key === u.speakerKey)) continue
      const plan = plans.find((p) => p.channel === u.channel)
      const voice = plan?.voices.get(u.speakerKey)
      const seconds =
        voice?.seconds ??
        finalUtterances.filter((x) => x.speakerKey === u.speakerKey).reduce((sum, x) => sum + (x.end - x.start) / 1000, 0)
      evidence.push({
        key: u.speakerKey,
        channel: u.channel,
        seconds: round3(seconds),
        embedding: voice?.embedding ?? null,
        firstStartMs: u.start
      })
    }
    const people = embeddingModel ? deps.voiceprints.candidates(embeddingModel) : []
    // Everyone Echo knows by voice can be misheard, in this meeting or not ("Daren Kudira").
    const remembered = deps.voiceprints.people().map((p) => p.name)
    let speakers = withCalendar(nameSpeakers(evidence, people, rec.name_hints, rec.app, { userName, ...DEFAULT_NAMING }), participants)

    // Names from the conversation for speakers still unnamed ("Hey Darin", "I'm Tanay").
    fixNames(finalUtterances, speakers, [...participants.map((p) => p.name), ...remembered], userName, deps.log)
    const unnamed = speakers.filter((s) => s.source === 'unknown').map((s) => s.label)
    if (unnamed.length && settings.claudeBaseUrl && secrets.claudeApiKey) {
      const ask = deps.speakerNames ?? ((u, n, c, cfg, key) => suggestSpeakerNames(u, n, c, cfg, key))
      const proposals = await ask(
        numbered(finalUtterances, speakers),
        unnamed,
        participants.map((p) => p.name),
        { claudeBaseUrl: settings.claudeBaseUrl, claudeModel: settings.claudeModel, fallbackModel: settings.fallbackModel },
        secrets.claudeApiKey
      )
      speakers = withConversationNames(speakers, proposals, participants)
      if (proposals.length) deps.log(`final pass: ${proposals.length} speaker name(s) found in the conversation`)
      fixNames(finalUtterances, speakers, [...participants.map((p) => p.name), ...remembered], userName, deps.log)
    }
    persistVoices(deps.meetingsDir, rec.uuid, embeddingModel, evidence)
    if (embeddingModel) autoEnrol(deps, speakers, evidence, embeddingModel, rec.app)

    deps.meetings.replaceWithFinal(
      meetingId,
      finalUtterances.map((u) => ({ start_ms: u.start, end_ms: u.end, channel: u.channel, speaker_key: u.speakerKey, text: u.text }))
    )
    rec = update({ speakers })

    // 7. Notes
    const notes = await writeNotes(rec, finalUtterances, speakers, settings, secrets, notesApi, step, deps.log)
    if (notes) rec = update({ notes })

    // 8. Saving
    step('Saving')
    const outputPath = writeMeetingMarkdown(rec, deps.meetings.segments(meetingId), outputDirFor(settings, deps.defaultOutputDir))
    rec = update({ output_path: outputPath, status: 'ready', progress: null, error: null })
    if (settings.meetingRetainAudioDays === 0 && rec.audio_dir) {
      rmSync(rec.audio_dir, { recursive: true, force: true })
      update({ audio_dir: null })
    }
    deps.log(`final pass: meeting ${meetingId} ready (${finalUtterances.length} utterances, ${speakers.length} speakers)`)
    deps.notify({ kind: 'notes-ready', title: 'Meeting notes ready', body: MEETING_APP_LABELS[rec.app], meetingId })
  } catch (e) {
    if (e instanceof MeetingGone) return
    const reason =
      e instanceof Error && (e.message === INTERRUPTED_ERROR || e.message === AUDIO_DELETED_ERROR) ? e.message : failureReason(e)
    deps.log(`final pass: meeting ${meetingId} failed (${describeError(e)})`)
    const row = deps.meetings.update(meetingId, { status: 'failed', error: reason, progress: null })
    if (!row) return
    deps.updated(meetingId)
    deps.notify({ kind: 'notes-failed', title: "Couldn't finish meeting notes", body: reason, meetingId })
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}

/** Keep each request under the shim's segment cap (a batch of many tiny turns can exceed it). */
function splitBatches<T extends { start: number; end: number; segments: AsrSegment[] }>(batches: T[]) {
  const out: Array<{ start: number; end: number; segments: AsrSegment[] }> = []
  for (const b of batches) {
    for (let i = 0; i < b.segments.length; i += MAX_SEGMENTS_PER_REQUEST) {
      const segments = b.segments.slice(i, i + MAX_SEGMENTS_PER_REQUEST)
      out.push({
        start: Math.min(...segments.map((s) => s.start)),
        end: Math.max(...segments.map((s) => s.end)),
        segments
      })
    }
  }
  return out
}

/** Local-only voice data for later "remember this voice"; outside the audio dir so retention keeps it. */
function persistVoices(meetingsDir: string, uuid: string, embeddingModel: string | null, evidence: SpeakerEvidence[]): void {
  const file: SpeakersFile = {
    embeddingModel,
    speakers: evidence.map((e) => ({ key: e.key, seconds: e.seconds, embedding: e.embedding }))
  }
  mkdirSync(meetingsDir, { recursive: true })
  writeFileSync(speakersFilePath(meetingsDir, uuid), JSON.stringify(file), 'utf8')
}

/** A clear voiceprint match adds this meeting's voice as another exemplar of that person. */
function autoEnrol(
  deps: FinalizeDeps,
  speakers: MeetingSpeaker[],
  evidence: SpeakerEvidence[],
  model: string,
  app: string
): void {
  for (const s of speakers) {
    if (s.source !== 'voiceprint' || s.personId === null || (s.score ?? 0) < AUTO_ENROL_SCORE) continue
    const voice = evidence.find((e) => e.key === s.key)
    if (!voice?.embedding) continue
    try {
      deps.voiceprints.addExemplar(s.personId, { embedding: voice.embedding, model, seconds: voice.seconds, sourceApp: app })
    } catch (e) {
      deps.log(`final pass: auto-enrol skipped (${describeError(e)})`)
    }
  }
}

/** Utterances numbered u1, u2, … in transcript order, with speaker labels, as notes cite them. */
function numbered(utterances: MeetingUtterance[], speakers: MeetingSpeaker[]): NotesUtterance[] {
  const labels = new Map(speakers.map((s) => [s.key, s.label]))
  return utterances.map((u, i) => ({ uid: `u${i + 1}`, speaker: labels.get(u.speakerKey) ?? u.speakerKey, startMs: u.start, text: u.text }))
}

function sameName(a: string, b: string): boolean {
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  return x === y || x.split(/\s+/)[0] === y.split(/\s+/)[0]
}

/**
 * The calendar's authority: with exactly one other attendee and one remote voice, that voice is
 * them. With several attendees, a voiceprint suggestion that names one of them is accepted.
 */
function withCalendar(speakers: MeetingSpeaker[], participants: MeetingParticipant[]): MeetingSpeaker[] {
  if (participants.length === 0) return speakers
  const remote = speakers.filter((s) => s.key.startsWith('others'))
  return numberUnknown(
    speakers.map((s): MeetingSpeaker => {
      if (s.source !== 'unknown' && s.source !== 'hint') return s
      if (participants.length === 1 && remote.length === 1 && s === remote[0]) {
        return { ...s, label: participants[0].name, source: 'calendar', suggestion: null }
      }
      const attendee = s.suggestion ? participants.find((p) => sameName(p.name, s.suggestion!)) : undefined
      if (attendee && s.source === 'unknown') return { ...s, label: s.suggestion!, source: 'voiceprint', suggestion: null }
      return s
    })
  )
}

/**
 * Apply names found in the conversation: one matching a calendar attendee names the speaker
 * ("from calendar"); anything else is only a suggestion. Named speakers are never touched.
 */
function withConversationNames(
  speakers: MeetingSpeaker[],
  proposals: SpeakerNameProposal[],
  participants: MeetingParticipant[]
): MeetingSpeaker[] {
  if (proposals.length === 0) return speakers
  const taken = new Set(speakers.filter((s) => s.source !== 'unknown').map((s) => s.label.toLowerCase()))
  return numberUnknown(
    speakers.map((s): MeetingSpeaker => {
      const p = s.source === 'unknown' ? proposals.find((x) => x.speaker === s.label) : undefined
      if (!p) return s
      const attendee = participants.find((a) => sameName(a.name, p.name))
      if (attendee && !taken.has(attendee.name.toLowerCase())) {
        taken.add(attendee.name.toLowerCase())
        return { ...s, label: attendee.name, source: 'calendar', suggestion: null }
      }
      return { ...s, suggestion: p.name }
    })
  )
}

/**
 * Correct misheard names in the transcript (in place), from every known name: the user, calendar
 * attendees and remembered voices (`people`), and named speakers.
 */
function fixNames(
  utterances: MeetingUtterance[],
  speakers: MeetingSpeaker[],
  people: string[],
  userName: string,
  log: (message: string) => void
): void {
  const known = [
    userName,
    ...people,
    ...speakers.filter((s) => s.source !== 'unknown').map((s) => s.label)
  ].filter((n) => n && !/^Speaker \d+$/.test(n))
  let count = 0
  for (const u of utterances) {
    const { text, fixes } = correctNames(u.text, known)
    u.text = text
    count += fixes.length
  }
  if (count) log(`final pass: corrected ${count} misheard name(s)`)
}

/** Draft (and, with a TypeSafe key, verify) the notes. Any failure leaves null; the meeting still ships. */
async function writeNotes(
  rec: MeetingRecord,
  utterances: MeetingUtterance[],
  speakers: MeetingSpeaker[],
  settings: Settings,
  secrets: Secrets,
  api: FinalizeNotes,
  step: (progress: string) => void,
  log: (message: string) => void
): Promise<MeetingNotes | null> {
  if (!settings.meetingNotes) return null
  if (!settings.claudeBaseUrl || !secrets.claudeApiKey) {
    log('final pass: notes skipped (AI proxy not configured)')
    return null
  }
  if (utterances.length === 0) {
    log('final pass: notes skipped (empty transcript)')
    return null
  }
  const utts = numbered(utterances, speakers)
  const participants = [...speakers].sort((a, b) => b.seconds - a.seconds).map((s) => s.label)
  const meta: NotesMeta = { appLabel: MEETING_APP_LABELS[rec.app], title: rec.title, startedAt: rec.started_at, participants }
  step('Writing notes')
  let notes: MeetingNotes
  try {
    const config: NotesConfig = {
      claudeBaseUrl: settings.claudeBaseUrl,
      claudeModel: settings.claudeModel,
      fallbackModel: settings.fallbackModel
    }
    notes = await api.draft(meta, utts, config, secrets.claudeApiKey)
  } catch (e) {
    log(`final pass: notes failed (${describeError(e)})`)
    return null
  }
  if (settings.meetingVerifyNotes && secrets.typesafeApiKey) {
    step('Verifying notes')
    try {
      notes = await api.verify(notes, utts, secrets.typesafeApiKey)
    } catch (e) {
      log(`final pass: verification failed (${describeError(e)}); notes kept unverified`)
    }
  }
  return notes
}
