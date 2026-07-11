import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LowConfidenceRecognitionError,
  recognizeAccurately,
  type AccuracyRequest,
  type RecognitionAudio,
  type RecognitionDeps,
  type SecondaryRecognizer
} from '../src/main/transcription/accuracy'
import { DEFAULT_SETTINGS, type NewTranscript, type Settings } from '@shared/types'
import type { TranscriptCandidate } from '@shared/transcript-quality'

const wav: RecognitionAudio = { path: '/tmp/echo-input.wav', buffer: new ArrayBuffer(4) }

const settings: Pick<
  Settings,
  'accuracyMode' | 'whisperBaseUrl' | 'whisperModel' | 'claudeBaseUrl' | 'claudeModel' | 'accuracyModel'
> = {
  accuracyMode: 'balanced',
  whisperBaseUrl: 'https://whisper.example/v1',
  whisperModel: 'whisper-1',
  claudeBaseUrl: 'https://claude.example/v1',
  claudeModel: 'claude-sonnet-4-6',
  accuracyModel: 'gpt-5.4-mini'
}

function request(overrides: Partial<AccuracyRequest> = {}): AccuracyRequest {
  return {
    settings,
    whisperApiKey: 'WHISPER',
    claudeApiKey: 'CLAUDE',
    appContext: 'Visual Studio Code',
    glossary: ['GB10'],
    prompt: 'GB10',
    ...overrides
  }
}

function deps(overrides: Partial<RecognitionDeps> = {}): RecognitionDeps {
  return {
    primary: vi.fn(async () => 'Please send the update.'),
    adjudicator: vi.fn(async () => null),
    ...overrides
  }
}

describe('recognizeAccurately', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.doUnmock('electron')
    vi.doUnmock('../src/main/transcription/accuracy')
    vi.doUnmock('../src/main/transcription/whisper')
    vi.doUnmock('../src/main/transcription/prewarm')
    vi.doUnmock('../src/main/insert/paste')
    vi.doUnmock('../src/main/insert/paste-deps')
    vi.doUnmock('../src/main/insert/window-focus')
    vi.doUnmock('../src/main/insert/selection')
    vi.doUnmock('../src/main/windows')
    vi.resetModules()
  })

  it('fast mode returns a clean primary without recovery or native work', async () => {
    const primary = vi.fn<RecognitionDeps['primary']>(async () => 'Please send the update.')
    const secondary: SecondaryRecognizer = { transcribe: vi.fn() }
    const adjudicator = vi.fn(async () => null)

    const outcome = await recognizeAccurately(
      wav,
      request({ settings: { ...settings, accuracyMode: 'fast' } }),
      deps({ primary, secondary, adjudicator })
    )

    expect(outcome.winner.source).toBe('remote-primary')
    expect(outcome.winner.text).toBe('Please send the update.')
    expect(primary).toHaveBeenCalledOnce()
    expect(primary.mock.calls[0][2]).toMatchObject({ temperature: 0, prompt: 'GB10' })
    expect(secondary.transcribe).not.toHaveBeenCalled()
    expect(adjudicator).not.toHaveBeenCalled()
  })

  it('balanced mode retries remotely and uses native only after a non-clean primary', async () => {
    const primary = vi
      .fn<RecognitionDeps['primary']>()
      .mockResolvedValueOnce('How do I force figure out?')
      .mockResolvedValueOnce('How do I figure it out?')
    const secondary = {
      transcribe: vi.fn(async (): Promise<TranscriptCandidate> => ({
        source: 'native',
        text: 'How do I figure it out?',
        elapsedMs: 12
      }))
    }

    const outcome = await recognizeAccurately(wav, request(), deps({ primary, secondary }))

    expect(outcome.winner.source).toBe('native')
    expect(primary.mock.calls.map((call) => call[2].temperature)).toEqual([0, 0.3])
    expect(secondary.transcribe).toHaveBeenCalledWith('/tmp/echo-input.wav', 'en-US')
  })

  it('balanced mode bounds native latency and keeps the safe recovery candidate', async () => {
    vi.useFakeTimers()
    const primary = vi
      .fn<RecognitionDeps['primary']>()
      .mockResolvedValueOnce('How do I force figure out?')
      .mockResolvedValueOnce('How do I figure it out?')
    const secondary = {
      transcribe: vi.fn(
        () =>
          new Promise<TranscriptCandidate>((resolve) => {
            setTimeout(() => resolve({ source: 'native', text: 'How do I figure it out?', elapsedMs: 10_000 }), 10_000)
          })
      )
    }

    const pending = recognizeAccurately(wav, request(), deps({ primary, secondary }))
    await vi.advanceTimersByTimeAsync(1500)

    await expect(pending).resolves.toMatchObject({
      winner: { source: 'remote-recovery', text: 'How do I figure it out?' }
    })
  })

  it('maximum mode uses a sampling ensemble so phonetic agreement can beat a fluent wrong primary', async () => {
    const primary = vi.fn<RecognitionDeps['primary']>(async (_wav, _request, opts) => {
      if (opts.temperature === 0) return "I'm a home, I'm a coffee."
      if (opts.temperature === 0.3) return "How's it going?"
      return "How's it away?"
    })
    const adjudicator = vi.fn(async (_candidates: TranscriptCandidate[]) => "How's it going?")

    const outcome = await recognizeAccurately(
      wav,
      request({ settings: { ...settings, accuracyMode: 'maximum' } }),
      deps({ primary, adjudicator })
    )

    expect(primary.mock.calls.map((call) => call[2].temperature)).toEqual([0, 0.3, 0.3, 0.3, 0.8])
    expect(adjudicator).toHaveBeenCalledOnce()
    const adjudicatedCandidates = adjudicator.mock.calls[0]?.[0] ?? []
    expect(adjudicatedCandidates.map((candidate) => candidate.text)).toEqual([
      "I'm a home, I'm a coffee.",
      "How's it going?",
      "How's it going?",
      "How's it going?",
      "How's it away?"
    ])
    expect(outcome.winner).toMatchObject({ source: 'adjudicated', text: "How's it going?" })
  })

  it('falls back to the best clean candidate when adjudication fails', async () => {
    const primary = vi.fn<RecognitionDeps['primary']>(async (_wav, _request, opts) =>
      opts.temperature === 0 ? 'Turn on captions.' : 'Turn off captions.'
    )
    const adjudicator = vi.fn(async () => {
      throw new Error('proxy down')
    })

    const outcome = await recognizeAccurately(
      wav,
      request({ settings: { ...settings, accuracyMode: 'maximum' } }),
      deps({ primary, adjudicator })
    )

    expect(outcome.winner).toMatchObject({ source: 'remote-recovery', text: 'Turn off captions.' })
  })

  it('maximum mode adjudicates every hypothesis when the lone English-looking decode is an outlier', async () => {
    const primary = vi.fn<RecognitionDeps['primary']>(async (_wav, _request, opts) => {
      if (opts.temperature === 0) return 'Einn snop og þá minn ekki röggli og feitsið gís.'
      if (opts.temperature === 0.3) return 'Eitt snobt og famið nekkarri klimófeyddshyllis.'
      return 'It is not or phonetic and heavy stuff.'
    })
    const adjudicator = vi.fn(async (_candidates: TranscriptCandidate[]) => 'It is not a funny necktie.')

    const outcome = await recognizeAccurately(
      wav,
      request({ settings: { ...settings, accuracyMode: 'maximum' } }),
      deps({ primary, adjudicator })
    )

    expect(adjudicator).toHaveBeenCalledOnce()
    expect((adjudicator.mock.calls[0]?.[0] ?? []).map((candidate) => candidate.text)).toHaveLength(5)
    expect(outcome.winner).toMatchObject({ source: 'adjudicated', text: 'It is not a funny necktie.' })
  })

  it('maximum mode fails safely when a lone clean outlier cannot be adjudicated', async () => {
    const primary = vi.fn<RecognitionDeps['primary']>(async (_wav, _request, opts) => {
      if (opts.temperature === 0) return 'Einn snop og þá minn ekki röggli og feitsið gís.'
      if (opts.temperature === 0.3) return 'Eitt snobt og famið nekkarri klimófeyddshyllis.'
      return 'It is not or phonetic and heavy stuff.'
    })
    const adjudicator = vi.fn(async () => null)

    await expect(
      recognizeAccurately(
        wav,
        request({ settings: { ...settings, accuracyMode: 'maximum' } }),
        deps({ primary, adjudicator })
      )
    ).rejects.toThrow(LowConfidenceRecognitionError)
  })

  it('uses glossary terms during quality assessment', async () => {
    const primary = vi.fn(async () => 'Deploy Þór now.')

    const outcome = await recognizeAccurately(
      wav,
      request({ settings: { ...settings, accuracyMode: 'fast' }, glossary: ['Þór'] }),
      deps({ primary })
    )

    expect(outcome.winner).toMatchObject({ source: 'remote-primary', text: 'Deploy Þór now.' })
  })

  it('rejects low confidence when every candidate is non-clean', async () => {
    const primary = vi
      .fn<RecognitionDeps['primary']>()
      .mockResolvedValueOnce('How do I force figure out?')
      .mockResolvedValueOnce("You're welcome.")

    await expect(recognizeAccurately(wav, request(), deps({ primary }))).rejects.toThrow(
      LowConfidenceRecognitionError
    )
  })
})

describe('DictationController accuracy integration', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.doUnmock('electron')
    vi.doUnmock('../src/main/transcription/accuracy')
    vi.doUnmock('../src/main/transcription/whisper')
    vi.doUnmock('../src/main/transcription/prewarm')
    vi.doUnmock('../src/main/insert/paste')
    vi.doUnmock('../src/main/insert/paste-deps')
    vi.doUnmock('../src/main/insert/window-focus')
    vi.doUnmock('../src/main/insert/selection')
    vi.doUnmock('../src/main/windows')
    vi.resetModules()
  })

  it('does not paste low-confidence output, retains audio, and records a failed row', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'echo-accuracy-'))
    const pasteText = vi.fn(async () => {})
    const history = { insert: vi.fn((row: NewTranscript) => ({ id: 1, ...row })) }
    let tempPathSeen = ''
    class MockLowConfidenceRecognitionError extends Error {
      constructor() {
        super('low confidence')
        this.name = 'LowConfidenceRecognitionError'
      }
    }
    const recognizeAccuratelyMock = vi.fn(async (audio: RecognitionAudio) => {
      tempPathSeen = audio.path
      expect(readFileSync(audio.path)).toEqual(Buffer.from([1, 2, 3, 4]))
      throw new MockLowConfidenceRecognitionError()
    })

    vi.doMock('electron', () => ({
      app: { getPath: () => userData },
      type: {}
    }))
    vi.doMock('../src/main/transcription/accuracy', () => ({
      LowConfidenceRecognitionError: MockLowConfidenceRecognitionError,
      isLowConfidenceRecognitionError: (e: unknown) => e instanceof MockLowConfidenceRecognitionError,
      recognizeAccurately: recognizeAccuratelyMock
    }))
    vi.doMock('../src/main/transcription/whisper', () => ({
      transcribe: vi.fn(async () => 'This text would paste.')
    }))
    vi.doMock('../src/main/transcription/prewarm', () => ({
      WhisperPrewarm: class {
        start(): void {}
        stop(): void {}
      }
    }))
    vi.doMock('../src/main/insert/paste', () => ({ pasteText }))
    vi.doMock('../src/main/insert/paste-deps', () => ({
      realPasteDeps: () => ({}),
      realSelectionDeps: () => ({})
    }))
    vi.doMock('../src/main/insert/window-focus', () => ({
      snapshotForegroundWindow: vi.fn(async () => ({ title: 'Visual Studio Code', focus: vi.fn() }))
    }))
    vi.doMock('../src/main/insert/selection', () => ({ captureSelection: vi.fn(async () => null) }))
    vi.doMock('../src/main/windows', () => ({ positionOverlay: vi.fn() }))

    try {
      const { DictationController } = await import('../src/main/dictation')
      const controller = new DictationController(
        {
          isDestroyed: () => false,
          webContents: { send: vi.fn() },
          showInactive: vi.fn(),
          hide: vi.fn()
        } as any,
        {
          getSettings: () => ({
            ...DEFAULT_SETTINGS,
            accuracyMode: 'maximum',
            cleanupMode: 'off',
            retainAudio: true,
            whisperBaseUrl: 'https://whisper.example/v1',
            claudeBaseUrl: 'https://claude.example/v1'
          }),
          getSecrets: () => ({ whisperApiKey: 'WHISPER', claudeApiKey: 'CLAUDE', syncToken: '' })
        } as any,
        history as any,
        { list: () => [], recordApplied: vi.fn() } as any,
        { list: () => [] } as any
      )

      const result = await controller.handleAudio(Uint8Array.from([1, 2, 3, 4]).buffer, {
        durationMs: 500,
        sampleRate: 16_000
      })

      expect(result).toMatchObject({ ok: false, error: 'low confidence' })
      expect(pasteText).not.toHaveBeenCalled()
      expect(existsSync(tempPathSeen)).toBe(false)
      const failedRow = history.insert.mock.calls[0][0]
      expect(failedRow).toMatchObject({ status: 'failed', model: 'low-confidence' })
      expect(failedRow.raw_text).toMatch(/low confidence/i)
      expect(failedRow.raw_text).not.toContain('This text would paste.')
      expect(failedRow.audio_path).toMatch(/audio/)
      if (!failedRow.audio_path) throw new Error('expected retained audio path')
      expect(readFileSync(failedRow.audio_path)).toEqual(Buffer.from([1, 2, 3, 4]))
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
