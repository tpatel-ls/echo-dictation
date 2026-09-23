import { describe, it, expect, beforeAll, beforeEach, afterEach, vi, type Mock } from 'vitest'
import path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { MeetingsStore } from '../src/main/store/meetings'
import { VoiceprintStore } from '../src/main/store/voiceprints'
import {
  finalizeMeeting,
  INTERRUPTED_ERROR,
  AUDIO_DELETED_ERROR,
  speakersFilePath,
  type FinalizeDeps,
  type FinalizeNotes,
  type FinalizeSpeech
} from '../src/main/meetings/finalize'
import { SpeechRouteError } from '../src/main/meetings/speech-client'
import { NotesError } from '../src/main/meetings/notes'
import type { DiarizationResult, MeetingNotes } from '@shared/meeting-types'
import { DEFAULT_SETTINGS, EMPTY_SECRETS, type Secrets, type Settings } from '@shared/types'

const WASM = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist')
const RATE = 16_000

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => path.join(WASM, f) })
})

function speechPcm(seconds: number): Buffer {
  const n = Math.round(seconds * RATE)
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t)
    b.writeInt16LE(Math.round(8000 * env * Math.sin(2 * Math.PI * 220 * t)), i * 2)
  }
  return b
}

const TEXTS: Record<string, string> = {
  o0: "Let's review the launch plan for Friday.",
  o1: 'I can renew the signing certificate today.',
  m0: 'Sounds good, I will update the checklist.'
}

const othersDiarization: DiarizationResult = {
  duration: 10,
  model: 'pyannote/speaker-diarization-community-1',
  embeddingModel: 'wespeaker-r34',
  embeddingDim: 4,
  segments: [
    { start: 0, end: 4, speaker: 'SPEAKER_00' },
    { start: 5, end: 9.5, speaker: 'SPEAKER_01' }
  ],
  speakers: [
    { id: 'SPEAKER_00', speechSeconds: 12, turns: 1, embedding: [1, 0, 0, 0] },
    { id: 'SPEAKER_01', speechSeconds: 11, turns: 1, embedding: [0, 1, 0, 0] }
  ]
}

const micDiarization: DiarizationResult = {
  ...othersDiarization,
  segments: [{ start: 1, end: 3.5, speaker: 'SPEAKER_00' }],
  speakers: [{ id: 'SPEAKER_00', speechSeconds: 2.5, turns: 1, embedding: [0, 0, 1, 0] }]
}

const notesFixture: MeetingNotes = {
  summary: ['The team planned the Friday launch.'],
  decisions: [{ text: 'Launch on Friday.', cites: ['u1'], verification: 'unverified' }],
  actionItems: [{ text: 'Renew the signing certificate.', owner: 'Speaker 2', due: 'today', cites: ['u3'], verification: 'unverified' }],
  openQuestions: [],
  model: 'claude-sonnet-5',
  verifiedBy: null
}

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'echo-final-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

interface Harness {
  deps: FinalizeDeps
  meetings: MeetingsStore
  voiceprints: VoiceprintStore
  speech: { diarize: Mock<FinalizeSpeech['diarize']>; transcribeSegments: Mock<FinalizeSpeech['transcribeSegments']> }
  notes: { draft: Mock<FinalizeNotes['draft']>; verify: Mock<FinalizeNotes['verify']> }
  speakerNames: Mock<NonNullable<FinalizeDeps['speakerNames']>>
  calendar: { participants: Mock<NonNullable<FinalizeDeps['calendar']>['participants']> }
  notified: Array<{ title: string; body: string; meetingId: number }>
  logs: string[]
  outDir: string
  meetingsDir: string
  create: (opts?: { mic?: Buffer; others?: Buffer; audio?: boolean }) => { id: number; audioDir: string; uuid: string }
}

function harness(settingsPatch: Partial<Settings> = {}, secretsPatch: Partial<Secrets> = {}): Harness {
  const db = new SQL.Database()
  const meetings = new MeetingsStore(db)
  const voiceprints = new VoiceprintStore(db)
  const meetingsDir = path.join(root, 'meetings')
  const outDir = path.join(root, 'out')
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    whisperBaseUrl: 'https://speech.example/v1',
    claudeBaseUrl: 'https://proxy.example',
    meetingOutputDir: outDir,
    meetingUserName: 'Tanay',
    ...settingsPatch
  }
  const secrets: Secrets = { ...EMPTY_SECRETS, whisperApiKey: 'w', claudeApiKey: 'c', ...secretsPatch }
  const speech = {
    diarize: vi.fn<FinalizeSpeech['diarize']>(async (_wav, opts) => (opts.maxSpeakers === 8 ? othersDiarization : micDiarization)),
    transcribeSegments: vi.fn<FinalizeSpeech['transcribeSegments']>(async (_wav, segments, models) =>
      segments.map((s) => ({ id: s.id, texts: Object.fromEntries(models.map((m) => [m, TEXTS[s.id] ?? ''])) }))
    )
  }
  const notes = {
    draft: vi.fn<FinalizeNotes['draft']>(async () => notesFixture),
    verify: vi.fn<FinalizeNotes['verify']>(async (n) => ({
      ...n,
      decisions: n.decisions.map((d) => ({ ...d, verification: 'supported' as const, confidence: 0.9 })),
      verifiedBy: 'jev-1'
    }))
  }
  const notified: Harness['notified'] = []
  const logs: string[] = []
  const speakerNames = vi.fn<NonNullable<FinalizeDeps['speakerNames']>>(async () => [])
  const calendar = { participants: vi.fn<NonNullable<FinalizeDeps['calendar']>['participants']>(async () => null) }
  const deps: FinalizeDeps = {
    meetings,
    voiceprints,
    settings: () => settings,
    secrets: () => secrets,
    dictionary: () => [],
    meetingsDir,
    defaultOutputDir: () => path.join(root, 'documents'),
    osUserName: () => 'jdoe',
    speech,
    notes,
    speakerNames,
    calendar,
    notify: ({ kind: _kind, ...n }) => notified.push(n),
    updated: () => {},
    log: (m) => logs.push(m)
  }
  let n = 0
  const create: Harness['create'] = (opts = {}) => {
    const uuid = `uuid-${++n}`
    const audioDir = path.join(meetingsDir, uuid)
    if (opts.audio !== false) {
      mkdirSync(audioDir, { recursive: true })
      writeFileSync(path.join(audioDir, 'mic.pcm'), opts.mic ?? speechPcm(10))
      writeFileSync(path.join(audioDir, 'others.pcm'), opts.others ?? speechPcm(10))
    }
    const row = meetings.create({
      uuid,
      started_at: new Date(2026, 8, 22, 14, 5).getTime(),
      app: 'google-meet',
      title: 'abc-defg-hij',
      audio_dir: audioDir,
      name_hints: []
    })
    meetings.update(row.id, { status: 'processing', ended_at: row.started_at + 10_000 })
    meetings.appendSegment(row.id, { start_ms: 0, end_ms: 4000, channel: 'others', speaker_key: 'others', text: 'live text', pass: 'live' })
    return { id: row.id, audioDir, uuid }
  }
  return { deps, meetings, voiceprints, speech, notes, speakerNames, calendar, notified, logs, outDir, meetingsDir, create }
}

describe('finalizeMeeting', () => {
  it('diarizes, transcribes, names, drafts notes and writes the .md', async () => {
    const h = harness({}, { typesafeApiKey: 'ts' })
    const { id, uuid, audioDir } = h.create()
    await finalizeMeeting(id, h.deps)

    const rec = h.meetings.get(id)!
    expect(rec.status).toBe('ready')
    expect(rec.progress).toBeNull()
    expect(rec.error).toBeNull()
    // Diarization hints per channel.
    expect(h.speech.diarize.mock.calls.map((c) => c[1])).toEqual([{ maxSpeakers: 8 }, { maxSpeakers: 4 }])
    // The primary and check models first, then the vocabulary model, all in one request.
    expect(h.speech.transcribeSegments.mock.calls[0][2]).toEqual(['canary-qwen-2.5b', 'parakeet-tdt-0.6b-v2', 'granite-speech-4.1-2b'])

    const segs = h.meetings.segments(id)
    expect(segs.every((s) => s.pass === 'final')).toBe(true)
    expect(segs.map((s) => [s.speaker_key, s.text])).toEqual([
      ['others:SPEAKER_00', TEXTS.o0],
      ['me', TEXTS.m0],
      ['others:SPEAKER_01', TEXTS.o1]
    ])
    expect(rec.speakers.map((s) => [s.key, s.label, s.source])).toEqual([
      ['me', 'Tanay', 'self'],
      ['others:SPEAKER_00', 'Speaker 1', 'unknown'],
      ['others:SPEAKER_01', 'Speaker 2', 'unknown']
    ])

    // Notes see numbered utterances with speaker labels, then get verified (a key exists).
    const [meta, utterances] = h.notes.draft.mock.calls[0]
    expect(meta).toMatchObject({ appLabel: 'Google Meet', title: 'abc-defg-hij' })
    expect(utterances.map((u) => [u.uid, u.speaker])).toEqual([
      ['u1', 'Speaker 1'],
      ['u2', 'Tanay'],
      ['u3', 'Speaker 2']
    ])
    expect(h.notes.verify).toHaveBeenCalledTimes(1)
    expect(rec.notes?.verifiedBy).toBe('jev-1')

    // The .md in the output folder, and the voices next to (not inside) the audio directory.
    expect(rec.output_path).toBe(path.join(h.outDir, '2026-09-22 1405 Google Meet - abc-defg-hij.md'))
    const md = readFileSync(rec.output_path!, 'utf8')
    expect(md).toContain('## Decisions')
    expect(md).toContain(`**[00:00:00] Speaker 1:** ${TEXTS.o0}`)
    const voices = JSON.parse(readFileSync(speakersFilePath(h.meetingsDir, uuid), 'utf8'))
    expect(voices.embeddingModel).toBe('wespeaker-r34')
    expect(path.dirname(speakersFilePath(h.meetingsDir, uuid))).not.toBe(audioDir)
    expect(existsSync(audioDir)).toBe(true) // retained (30 days by default)
    expect(h.notified).toEqual([{ title: 'Meeting notes ready', body: 'Google Meet', meetingId: id }])
  })

  it('falls back to one speaker per channel when the diarizer is unavailable', async () => {
    const h = harness()
    h.speech.diarize.mockRejectedValue(new SpeechRouteError('Speech server returned 502: diarizer unavailable', 502))
    h.speech.transcribeSegments.mockImplementation(async (_wav, segments, models) =>
      segments.map((s) => ({
        id: s.id,
        texts: Object.fromEntries(models.map((m) => [m, s.id.startsWith('m') ? 'I agree with that plan' : 'We ship on Friday then']))
      }))
    )
    const { id } = h.create()
    await finalizeMeeting(id, h.deps)

    const rec = h.meetings.get(id)!
    expect(rec.status).toBe('ready')
    expect(new Set(h.meetings.segments(id).map((s) => s.speaker_key))).toEqual(new Set(['me', 'others']))
    expect(rec.speakers.map((s) => s.key).sort()).toEqual(['me', 'others'])
    expect(h.logs.some((l) => l.includes('diarizer unavailable'))).toBe(true)
  })

  it('fails the meeting on an auth error from the diarizer instead of falling back', async () => {
    const h = harness()
    h.speech.diarize.mockRejectedValue(new SpeechRouteError('Speech server returned 401: bad key', 401))
    const { id } = h.create()
    await finalizeMeeting(id, h.deps)
    const rec = h.meetings.get(id)!
    expect(rec.status).toBe('failed')
    expect(rec.error).toContain('401')
    // The live transcript survives a failed pass.
    expect(h.meetings.segments(id).map((s) => s.pass)).toEqual(['live'])
    expect(h.notified[0].title).toBe("Couldn't finish meeting notes")
  })

  it('ships the transcript without notes when drafting fails', async () => {
    const h = harness()
    h.notes.draft.mockRejectedValue(new NotesError('Claude returned 529', 529))
    const { id } = h.create()
    await finalizeMeeting(id, h.deps)
    const rec = h.meetings.get(id)!
    expect(rec.status).toBe('ready')
    expect(rec.notes).toBeNull()
    expect(existsSync(rec.output_path!)).toBe(true)
    expect(h.logs.some((l) => l.includes('notes failed (NotesError 529)'))).toBe(true)
  })

  it('verifies notes only when a TypeSafe key exists', async () => {
    const h = harness()
    const { id } = h.create()
    await finalizeMeeting(id, h.deps)
    expect(h.notes.draft).toHaveBeenCalledTimes(1)
    expect(h.notes.verify).not.toHaveBeenCalled()
    expect(h.meetings.get(id)!.notes?.verifiedBy).toBeNull()
  })

  it('skips notes when turned off or the proxy is not configured', async () => {
    const off = harness({ meetingNotes: false })
    await finalizeMeeting(off.create().id, off.deps)
    expect(off.notes.draft).not.toHaveBeenCalled()
    const noProxy = harness({}, { claudeApiKey: '' })
    const { id } = noProxy.create()
    await finalizeMeeting(id, noProxy.deps)
    expect(noProxy.notes.draft).not.toHaveBeenCalled()
    expect(noProxy.meetings.get(id)!.status).toBe('ready')
  })

  it('deletes the audio right away when retention is 0 days, keeping the voices file', async () => {
    const h = harness({ meetingRetainAudioDays: 0 })
    const { id, audioDir, uuid } = h.create()
    await finalizeMeeting(id, h.deps)
    const rec = h.meetings.get(id)!
    expect(rec.status).toBe('ready')
    expect(rec.audio_dir).toBeNull()
    expect(existsSync(audioDir)).toBe(false)
    expect(existsSync(speakersFilePath(h.meetingsDir, uuid))).toBe(true)
  })

  it('fails with the interrupted reason when no audio was saved', async () => {
    const h = harness()
    const { id } = h.create({ mic: Buffer.alloc(0), others: Buffer.alloc(0) })
    await finalizeMeeting(id, h.deps)
    const rec = h.meetings.get(id)!
    expect(rec.status).toBe('failed')
    expect(rec.error).toBe(INTERRUPTED_ERROR)
    expect(h.speech.diarize).not.toHaveBeenCalled()
  })

  it('fails with "Audio was already deleted" when the audio directory is gone', async () => {
    const h = harness()
    const { id } = h.create({ audio: false })
    await finalizeMeeting(id, h.deps)
    expect(h.meetings.get(id)!.error).toBe(AUDIO_DELETED_ERROR)
  })

  it('names a remembered voice and enrols this meeting as another exemplar', async () => {
    const h = harness()
    const blake = h.voiceprints.ensurePerson('Blake Whitmore')
    h.voiceprints.addExemplar(blake.id, { embedding: [0.99, 0.05, 0, 0], model: 'wespeaker-r34', seconds: 20, sourceApp: 'slack' })
    const { id } = h.create()
    await finalizeMeeting(id, h.deps)
    const rec = h.meetings.get(id)!
    expect(rec.speakers.find((s) => s.key === 'others:SPEAKER_00')).toMatchObject({
      label: 'Blake Whitmore',
      source: 'voiceprint',
      personId: blake.id
    })
    expect(rec.speakers.find((s) => s.key === 'others:SPEAKER_01')?.label).toBe('Speaker 1')
    expect(h.voiceprints.people()[0].exemplars).toBe(2)
  })

  it('appends (2) instead of overwriting another meeting\'s .md', async () => {
    const h = harness()
    const first = h.create()
    const second = h.create()
    await finalizeMeeting(first.id, h.deps)
    await finalizeMeeting(second.id, h.deps)
    expect(path.basename(h.meetings.get(second.id)!.output_path!)).toBe('2026-09-22 1405 Google Meet - abc-defg-hij (2).md')
    // A reprocess rewrites its own file rather than making a third.
    await finalizeMeeting(first.id, h.deps)
    expect(path.basename(h.meetings.get(first.id)!.output_path!)).toBe('2026-09-22 1405 Google Meet - abc-defg-hij.md')
  })

  it('never transcribes what was said while the mic was paused (nor the second before)', async () => {
    const h = harness()
    const { id, audioDir } = h.create()
    // Paused from 1.5 s to the end: with the 1 s margin only 0.5 s of mic speech remains, too
    // little to transcribe at all.
    writeFileSync(path.join(audioDir, 'mic-pauses.json'), JSON.stringify([{ from: 24_000, to: null }]))
    await finalizeMeeting(id, h.deps)
    expect(h.speech.diarize.mock.calls.map((c) => c[1])).toEqual([{ maxSpeakers: 8 }])
    expect(h.meetings.segments(id).some((s) => s.channel === 'mic')).toBe(false)
  })

  it('stops quietly when the meeting is deleted mid-pass', async () => {
    const h = harness()
    const { id } = h.create()
    h.speech.diarize.mockImplementation(async (_wav, opts) => {
      h.meetings.delete(id)
      return opts.maxSpeakers === 8 ? othersDiarization : micDiarization
    })
    await finalizeMeeting(id, h.deps)
    expect(h.meetings.get(id)).toBeNull()
    expect(h.notified).toEqual([])
  })

  describe('keywords (Granite)', () => {
    const dictEntry = (word: string, misheard: string[] = []) => ({ id: 1, word, misheard, source: 'manual' as const, created_at: 1, times_applied: 0 })

    it("sends the meeting's people, remembered voices and dictionary words as the keyword prompt", async () => {
      const h = harness()
      h.calendar.participants.mockResolvedValue([{ name: 'Darin Kadiro', email: null }])
      h.voiceprints.ensurePerson('Blake Whitmore')
      h.deps.dictionary = () => [dictEntry('Zeltra', ['zebra']), dictEntry('BROXA')]
      const { id } = h.create()
      h.meetings.update(id, { name_hints: ['Nadia Cole'] })
      await finalizeMeeting(id, h.deps)
      const prompts = h.speech.transcribeSegments.mock.calls.map((c) => c[4])
      expect(prompts.length).toBeGreaterThan(0)
      expect(new Set(prompts)).toEqual(new Set(['Tanay, Darin Kadiro, Nadia Cole, Blake Whitmore, Zeltra, BROXA']))
      expect(h.logs).toContain('final pass: 6 keyword(s) for the transcription models')
    })

    it("still sends the user's own name when nothing else is known", async () => {
      const h = harness()
      const { id } = h.create()
      await finalizeMeeting(id, h.deps)
      expect(h.speech.transcribeSegments.mock.calls[0][4]).toBe('Tanay')
    })

    it("punctuates Granite's keyword-biased text from Parakeet's sentence breaks", async () => {
      const h = harness({ meetingFinalModel: 'granite-speech-4.1-2b' })
      h.speech.transcribeSegments.mockImplementation(async (_wav, segments, models) =>
        segments.map((s) => ({
          id: s.id,
          texts:
            s.id === 'm0'
              ? { 'granite-speech-4.1-2b': 'the only board we check is BROXA we switch next month', 'parakeet-tdt-0.6b-v2': 'The only board we check is brocksa. We switch next month.' }
              : Object.fromEntries(models.map((m) => [m, TEXTS[s.id] ?? '']))
        }))
      )
      const { id } = h.create()
      await finalizeMeeting(id, h.deps)
      expect(h.meetings.segments(id).map((s) => s.text)).toContain('The only board we check is BROXA. We switch next month.')
    })

    it('keeps the dictionary, name-correction and hallucination passes with Granite as the primary model', async () => {
      const h = harness({ meetingFinalModel: 'granite-speech-4.1-2b' })
      h.calendar.participants.mockResolvedValue([{ name: 'Darin Kadiro', email: null }])
      h.deps.dictionary = () => [dictEntry('Zeltra', ['zebra'])]
      h.speech.transcribeSegments.mockImplementation(async (_wav, segments, models) =>
        segments.map((s) => ({
          id: s.id,
          texts:
            s.id === 'm0'
              ? { 'granite-speech-4.1-2b': 'Hey Deren, we pay vendors through zebra.', 'parakeet-tdt-0.6b-v2': 'Hey Deren we pay vendors through zebra' }
              : s.id === 'o1'
                ? { 'granite-speech-4.1-2b': 'Thank you.', 'parakeet-tdt-0.6b-v2': '' } // invented on noise
                : Object.fromEntries(models.map((m) => [m, TEXTS[s.id] ?? '']))
        }))
      )
      const { id } = h.create()
      await finalizeMeeting(id, h.deps)
      expect(h.speech.transcribeSegments.mock.calls[0][2]).toEqual(['granite-speech-4.1-2b', 'parakeet-tdt-0.6b-v2'])
      const texts = h.meetings.segments(id).map((s) => s.text)
      expect(texts).toContain('Hey Darin, we pay vendors through Zeltra.')
      expect(texts.join(' | ')).not.toContain('Thank you.')
    })
  })

  describe('vocabulary model (Granite)', () => {
    const CANARY = 'canary-qwen-2.5b'
    const PARAKEET = 'parakeet-tdt-0.6b-v2'
    const GRANITE = 'granite-speech-4.1-2b'
    const dictEntry = (word: string) => ({ id: 1, word, misheard: [], source: 'manual' as const, created_at: 1, times_applied: 0 })
    const clipTexts = (m0: Record<string, string>) =>
      vi.fn<FinalizeSpeech['transcribeSegments']>(async (_wav, segments, models) =>
        segments.map((s) => ({
          id: s.id,
          texts: s.id === 'm0' ? Object.fromEntries(models.filter((m) => m in m0).map((m) => [m, m0[m]])) : Object.fromEntries(models.map((m) => [m, TEXTS[s.id] ?? '']))
        }))
      )

    it("takes Granite's spelling of a listed term the chosen text misheard, and never a name Granite inserted", async () => {
      const h = harness()
      h.deps.dictionary = () => [dictEntry('Zeltra')]
      h.voiceprints.ensurePerson('Jordan Whitmore')
      h.speech.transcribeSegments = clipTexts({
        [CANARY]: 'We pay through zebra, the draft is in here.',
        [PARAKEET]: 'We pay through zebra, the draft is in here.',
        [GRANITE]: 'we pay through Zeltra the draft is Jordan'
      })
      h.deps.speech = h.speech
      const { id } = h.create()
      await finalizeMeeting(id, h.deps)
      expect(h.meetings.segments(id).map((s) => s.text)).toContain('We pay through Zeltra, the draft is in here.')
      expect(h.logs).toContain('final pass: 1 word(s) spelt as the vocabulary model heard them')
    })

    it('is off when the vocabulary model is empty or already the primary model', async () => {
      for (const patch of [{ meetingVocabModel: '' }, { meetingFinalModel: GRANITE }]) {
        const h = harness(patch)
        h.deps.dictionary = () => [dictEntry('Zeltra')]
        h.speech.transcribeSegments = clipTexts({ [CANARY]: 'We pay through zebra.', [PARAKEET]: 'We pay through zebra.', [GRANITE]: 'We pay through Zeltra.' })
        h.deps.speech = h.speech
        const { id } = h.create()
        await finalizeMeeting(id, h.deps)
        expect(h.speech.transcribeSegments.mock.calls[0][2]).toEqual(patch.meetingFinalModel ? [GRANITE, PARAKEET] : [CANARY, PARAKEET])
      }
    })

    it('finishes without the transplant when the request with Granite fails', async () => {
      const h = harness()
      h.deps.dictionary = () => [dictEntry('Zeltra')]
      const texts = clipTexts({ [CANARY]: 'We pay through zebra.', [PARAKEET]: 'We pay through zebra.', [GRANITE]: 'We pay through Zeltra.' })
      h.speech.transcribeSegments = vi.fn<FinalizeSpeech['transcribeSegments']>(async (...args) => {
        if (args[2].includes(GRANITE)) throw new SpeechRouteError('Speech server returned 502: granite unavailable', 502)
        return texts(...args)
      })
      h.deps.speech = h.speech
      const { id } = h.create()
      await finalizeMeeting(id, h.deps)
      const rec = h.meetings.get(id)!
      expect(rec.status).toBe('ready')
      expect(h.meetings.segments(id).map((s) => s.text)).toContain('We pay through zebra.')
      expect(h.logs).toContain('final pass: vocabulary model failed (SpeechRouteError 502); continuing without it')
      // Given up after the first failure: later batches go straight to the two models.
      expect(h.speech.transcribeSegments.mock.calls.filter((c) => c[2].includes(GRANITE))).toHaveLength(1)
    })
  })

  describe('names', () => {
    it('merges the remote voices and names them from the calendar when one other person attended', async () => {
      const h = harness()
      h.calendar.participants.mockResolvedValue([{ name: 'Darin Kadiro', email: 'darin@example.org' }])
      const { id } = h.create()
      await finalizeMeeting(id, h.deps)
      const rec = h.meetings.get(id)!
      expect(rec.participants).toEqual([{ name: 'Darin Kadiro', email: 'darin@example.org' }])
      expect(rec.speakers.map((s) => [s.key, s.label, s.source])).toEqual([
        ['me', 'Tanay', 'self'],
        ['others:SPEAKER_00', 'Darin Kadiro', 'calendar']
      ])
      expect(new Set(h.meetings.segments(id).map((s) => s.speaker_key))).toEqual(new Set(['me', 'others:SPEAKER_00']))
      expect(h.logs.some((l) => l.includes('merged a others speaker (single-attendee'))).toBe(true)
      expect(h.speakerNames).not.toHaveBeenCalled() // nobody is left unnamed
    })

    it('corrects misheard participant names in the transcript', async () => {
      const h = harness()
      h.calendar.participants.mockResolvedValue([{ name: 'Darin Kadiro', email: null }])
      h.speech.transcribeSegments.mockImplementation(async (_wav, segments, models) =>
        segments.map((s) => ({
          id: s.id,
          texts: Object.fromEntries(models.map((m) => [m, s.id === 'm0' ? 'Hey Deren, how are you?' : 'Hi Thane, nice to meet you.']))
        }))
      )
      const { id } = h.create()
      await finalizeMeeting(id, h.deps)
      const texts = h.meetings.segments(id).map((s) => s.text).join(' | ')
      expect(texts).toContain('Hey Darin, how are you?')
      expect(texts).toContain('Hi Tanay, nice to meet you.')
    })

    it('corrects names of people Echo knows by voice, even when they are not in this meeting (a Slack huddle)', async () => {
      const h = harness()
      h.voiceprints.ensurePerson('Darin Kadiro') // remembered from an earlier interview; not in this call
      h.speech.transcribeSegments.mockImplementation(async (_wav, segments, models) =>
        segments.map((s) => ({
          id: s.id,
          texts: Object.fromEntries(models.map((m) => [m, s.id === 'm0' ? "She's fine with the schedule, Daren uh Daren Kudira." : 'What is his name?']))
        }))
      )
      const { id } = h.create()
      await finalizeMeeting(id, h.deps)
      const texts = h.meetings.segments(id).map((s) => s.text).join(' | ')
      expect(texts).toContain("She's fine with the schedule, Darin uh Darin Kadiro.")
      expect(h.logs).toContain('final pass: corrected 2 misheard name(s)')
    })

    it('uses a name from the conversation: a calendar attendee names the speaker, anything else is a suggestion', async () => {
      const h = harness()
      h.calendar.participants.mockResolvedValue([
        { name: 'Darin Kadiro', email: null },
        { name: 'Blake Whitmore', email: null }
      ])
      h.speakerNames.mockResolvedValue([
        { speaker: 'Speaker 1', name: 'Darin', cites: ['u1'] },
        { speaker: 'Speaker 2', name: 'Priya', cites: ['u3'] }
      ])
      const { id } = h.create()
      await finalizeMeeting(id, h.deps)
      const [, unnamed, candidates] = h.speakerNames.mock.calls[0]
      expect(unnamed).toEqual(['Speaker 1', 'Speaker 2'])
      expect(candidates).toEqual(['Darin Kadiro', 'Blake Whitmore'])
      expect(h.meetings.get(id)!.speakers.map((s) => [s.key, s.label, s.source, s.suggestion])).toEqual([
        ['me', 'Tanay', 'self', null],
        ['others:SPEAKER_00', 'Darin Kadiro', 'calendar', null],
        ['others:SPEAKER_01', 'Speaker 1', 'unknown', 'Priya']
      ])
    })

    it('never lets the conversation rename a remembered voice', async () => {
      const h = harness()
      const blake = h.voiceprints.ensurePerson('Blake Whitmore')
      h.voiceprints.addExemplar(blake.id, { embedding: [1, 0, 0, 0], model: 'wespeaker-r34', seconds: 20, sourceApp: 'slack' })
      h.speakerNames.mockResolvedValue([{ speaker: 'Blake Whitmore', name: 'Darin', cites: ['u1'] }])
      const { id } = h.create()
      await finalizeMeeting(id, h.deps)
      expect(h.meetings.get(id)!.speakers.find((s) => s.key === 'others:SPEAKER_00')).toMatchObject({ label: 'Blake Whitmore', source: 'voiceprint' })
    })

    it('never sends a diarized turn over silence to the models (a click became "Okay.")', async () => {
      const h = harness()
      h.speech.diarize.mockImplementation(async (_wav, opts) =>
        opts.maxSpeakers === 8
          ? { ...othersDiarization, segments: [...othersDiarization.segments, { start: 11.2, end: 11.7, speaker: 'SPEAKER_01' }] }
          : micDiarization
      )
      const { id } = h.create({ others: Buffer.concat([speechPcm(10), Buffer.alloc(16_000 * 2 * 3)]) })
      await finalizeMeeting(id, h.deps)
      const sent = h.speech.transcribeSegments.mock.calls.flatMap((c) => c[1].map((s) => s.id))
      expect(sent).not.toContain('o2')
      expect(sent).toContain('o0')
    })

    it('drops filler-only lines and trusts the check model on very short clips', async () => {
      const h = harness()
      h.speech.diarize.mockImplementation(async (_wav, opts) =>
        opts.maxSpeakers === 8
          ? {
              ...othersDiarization,
              segments: [
                { start: 0, end: 4, speaker: 'SPEAKER_00' },
                { start: 6, end: 6.8, speaker: 'SPEAKER_01' },
                { start: 8, end: 9, speaker: 'SPEAKER_01' }
              ]
            }
          : micDiarization
      )
      h.speech.transcribeSegments.mockImplementation(async (_wav, segments) =>
        segments.map((s) => ({
          id: s.id,
          texts:
            s.id === 'o1'
              ? { 'canary-qwen-2.5b': 'Amen', 'parakeet-tdt-0.6b-v2': 'Mm-hmm' }
              : s.id === 'o2'
                ? { 'canary-qwen-2.5b': 'Um', 'parakeet-tdt-0.6b-v2': 'Um' }
                : { 'canary-qwen-2.5b': TEXTS[s.id] ?? 'Sure.', 'parakeet-tdt-0.6b-v2': TEXTS[s.id] ?? 'Sure.' }
        }))
      )
      const { id } = h.create()
      await finalizeMeeting(id, h.deps)
      const texts = h.meetings.segments(id).map((s) => s.text)
      expect(texts).toContain('Mm-hmm')
      expect(texts).not.toContain('Amen')
      expect(texts).not.toContain('Um')
    })
  })
})
