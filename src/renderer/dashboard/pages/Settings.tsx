import { useEffect, useId, useState, type ReactNode } from 'react'
import type { MaskedSecrets, Secrets, Settings as SettingsType } from '@shared/types'
import { MEETING_APP_IDS, MEETING_APP_LABELS } from '@shared/meeting-types'
import { triggerLabel, triggerOptions } from '@shared/trigger'
import { api } from '../lib/api'
import { Field, TextInput, Select } from '../components/Field'
import { Toggle } from '../components/Toggle'
import { validateEndpointUrl } from '@shared/endpoints'
import { ChevronRight } from 'lucide-react'

export function Settings({ notify }: { notify: (m: string) => void }): JSX.Element {
  const [s, setS] = useState<SettingsType | null>(null)
  const [masked, setMasked] = useState<MaskedSecrets | null>(null)
  const [whisperKey, setWhisperKey] = useState('')
  const [claudeKey, setClaudeKey] = useState('')
  const [syncToken, setSyncToken] = useState('')
  const [typesafeKey, setTypesafeKey] = useState('')
  const [calendarUrl, setCalendarUrl] = useState('')
  const [testingCalendar, setTestingCalendar] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [audioInputs, setAudioInputs] = useState<Array<{ deviceId: string; label: string }>>([])

  useEffect(() => {
    void (async () => {
      setS(await api.settings.get())
      setMasked(await api.settings.getSecretsMasked())
    })()
  }, [])

  useEffect(() => {
    const refresh = async (): Promise<void> => {
      const devices = await navigator.mediaDevices?.enumerateDevices().catch(() => [])
      setAudioInputs(
        (devices ?? [])
          .filter((device) => device.kind === 'audioinput' && device.deviceId !== 'default')
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `Microphone ${index + 1}`
          }))
      )
    }
    void refresh()
    navigator.mediaDevices?.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh)
  }, [])

  if (!s) return <div className="p-7 text-muted text-sm">Loading…</div>

  const patch = async (p: Partial<SettingsType>): Promise<void> => {
    setS(await api.settings.set(p))
  }

  const saveKeys = async (): Promise<void> => {
    const body: Partial<Secrets> = {}
    if (whisperKey) body.whisperApiKey = whisperKey
    if (claudeKey) body.claudeApiKey = claudeKey
    if (syncToken) body.syncToken = syncToken
    if (typesafeKey) body.typesafeApiKey = typesafeKey
    if (calendarUrl) body.calendarIcsUrl = calendarUrl.trim()
    if (Object.keys(body).length === 0) return
    await api.settings.setSecrets(body)
    setWhisperKey('')
    setClaudeKey('')
    setSyncToken('')
    setTypesafeKey('')
    setCalendarUrl('')
    setMasked(await api.settings.getSecretsMasked())
    notify('Saved (encrypted)')
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-7 pt-6 pb-4 border-b border-border">
        <h1 className="text-lg font-semibold">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto px-7 py-2">
        <div className="max-w-2xl">
          <Section title="Dictation">
            <Field
              label="Trigger key"
              hint={
                api.platform === 'darwin'
                  ? 'Hold this key anywhere to dictate. Right ⌘ keeps your normal shortcuts free.'
                  : 'Hold this key anywhere to dictate. Right Ctrl keeps your normal Ctrl shortcuts free.'
              }
            >
              <Select
                value={s.triggerKey}
                onChange={(v) => void patch({ triggerKey: v })}
                options={triggerOptions(api.platform).map((k) => ({ value: k, label: triggerLabel(k) }))}
              />
            </Field>
            <Field label="Minimum hold" hint="Ignore taps shorter than this — avoids accidental triggers.">
              <div className="flex items-center gap-2">
                <TextInput
                  type="number"
                  width="w-20"
                  min={0}
                  max={2000}
                  step={50}
                  value={String(s.minHoldMs)}
                  onChange={(v) => void patch({ minHoldMs: clampInt(v, 0, 2000) })}
                />
                <span className="text-xs text-muted">ms</span>
              </div>
            </Field>
            <Field
              label="Cancel on other key"
              hint="If you press another key while holding, treat it as a shortcut and cancel dictation."
            >
              <Toggle checked={s.cancelOnOtherKey} onChange={(v) => void patch({ cancelOnOtherKey: v })} />
            </Field>
            <Field
              label="Accuracy"
              hint="Balanced inserts one fast high-quality decode and runs recovery only when needed. Maximum compares several decodes with native speech where available."
            >
              <Select
                value={s.accuracyMode}
                onChange={(v) => void patch({ accuracyMode: v })}
                options={[
                  { value: 'maximum', label: 'Maximum' },
                  { value: 'balanced', label: 'Balanced' },
                  { value: 'fast', label: 'Fast' }
                ]}
              />
            </Field>
            <Field
              label="Live preview"
              hint="Show words above the bar while you speak, decoded by the Parakeet preview model."
            >
              <Toggle checked={s.livePreview} onChange={(v) => void patch({ livePreview: v })} />
            </Field>
          </Section>

          <Section title="Transcription (Whisper)">
            <EndpointField
              label="Base URL"
              value={s.whisperBaseUrl}
              required
              serviceLabel="Whisper"
              onSave={(value) => patch({ whisperBaseUrl: value })}
            />
            <Field label="Model" hint="Decodes the text that gets pasted.">
              <TextInput width="w-44" value={s.whisperModel} onChange={(v) => void patch({ whisperModel: v })} />
            </Field>
            <Field
              label="Cross-check models"
              hint="Comma-separated models decoded alongside the main one in Balanced mode. Two agreeing models win; Canary models only vote on short phrases."
            >
              <TextInput
                width="w-72"
                value={s.crossCheckModels}
                onChange={(v) => void patch({ crossCheckModels: v })}
              />
            </Field>
            <Field label="Preview model" hint="Fast model for the live transcript while you speak.">
              <TextInput width="w-44" value={s.previewModel} onChange={(v) => void patch({ previewModel: v })} />
            </Field>
            <Field label="API key" hint={masked?.whisperApiKey ? `Current: ${masked.whisperApiKey}` : 'Not set'}>
              <TextInput type="password" value={whisperKey} placeholder="Enter to change" onChange={setWhisperKey} />
            </Field>
          </Section>

          <Section title="AI cleanup (Claude)">
            <Field
              label="Cleanup mode"
              hint="Auto applies smart English punctuation, paragraphs, lists, and self-corrections before inserting."
            >
              <Select
                value={s.cleanupMode}
                onChange={(v) => void patch({ cleanupMode: v })}
                options={[
                  { value: 'off', label: 'Off (raw)' },
                  { value: 'on-demand', label: 'On-demand' },
                  { value: 'auto', label: 'Auto' }
                ]}
              />
            </Field>
            <Field
              label="Voice commands"
              hint="When text is selected, treat your dictation as an instruction to rewrite it in place (e.g. 'make this formal'). Needs Claude."
            >
              <Toggle
                checked={s.commandModeEnabled}
                onChange={(v) => void patch({ commandModeEnabled: v })}
              />
            </Field>
            <EndpointField
              label="Base URL"
              value={s.claudeBaseUrl}
              serviceLabel="Cleanup"
              onSave={(value) => patch({ claudeBaseUrl: value })}
            />
            <Field label="Model">
              <TextInput width="w-52" value={s.claudeModel} onChange={(v) => void patch({ claudeModel: v })} />
            </Field>
            <Field
              label="Fallback model"
              hint="Tried last when the proxy cannot serve the cleanup or Claude model, e.g. the newest GPT."
            >
              <TextInput width="w-52" value={s.fallbackModel} onChange={(v) => void patch({ fallbackModel: v })} />
            </Field>
            <Field
              label="Adjudicator model"
              hint="Fast model that picks the right transcript when speech models disagree. Empty uses the cleanup model."
            >
              <TextInput
                width="w-52"
                value={s.adjudicatorModel}
                onChange={(v) => void patch({ adjudicatorModel: v })}
              />
            </Field>
            <Field label="API key" hint={masked?.claudeApiKey ? `Current: ${masked.claudeApiKey}` : 'Not set'}>
              <TextInput type="password" value={claudeKey} placeholder="Enter to change" onChange={setClaudeKey} />
            </Field>
          </Section>

          <Section title="Sync">
            <EndpointField
              label="Service URL"
              hint="Leave blank to keep this device local-only."
              value={s.syncBaseUrl}
              serviceLabel="Sync"
              onSave={(value) => patch({ syncBaseUrl: value })}
            />
            <Field label="Token" hint={masked?.syncToken ? `Current: ${masked.syncToken}` : 'Not set'}>
              <TextInput type="password" value={syncToken} placeholder="Enter to change" onChange={setSyncToken} />
            </Field>
          </Section>

          <Section title="Meetings">
            {api.platform !== 'win32' ? (
              <p className="py-3.5 text-sm text-muted">Meeting transcription is available on Windows</p>
            ) : (
              <>
                <Field
                  label="Automatically transcribe meetings"
                  hint="Records only while a meeting app below holds the mic in a call, and shows a pill at the top of the screen while it does."
                >
                  <Toggle
                    checked={s.meetingMode === 'auto'}
                    onChange={(v) => void patch({ meetingMode: v ? 'auto' : 'off' })}
                  />
                </Field>
                {MEETING_APP_IDS.map((id) => (
                  <Field key={id} label={MEETING_APP_LABELS[id]}>
                    <Toggle
                      label={MEETING_APP_LABELS[id]}
                      checked={s.meetingApps[id]}
                      disabled={s.meetingMode !== 'auto'}
                      onChange={(v) => void patch({ meetingApps: { ...s.meetingApps, [id]: v } })}
                    />
                  </Field>
                ))}
                <Field label="Your name in transcripts" hint="How your own voice is labelled.">
                  <DraftInput
                    width="w-64"
                    value={s.meetingUserName}
                    placeholder="Uses your Windows account name"
                    onSave={(v) => patch({ meetingUserName: v.trim() })}
                  />
                </Field>
                <Field label="Notes folder" hint="Each meeting's notes are also saved here as a Markdown file.">
                  <DraftInput
                    width="w-64"
                    value={s.meetingOutputDir}
                    placeholder="Documents\Echo Meetings"
                    onSave={(v) => patch({ meetingOutputDir: v.trim() })}
                  />
                </Field>
                <Field
                  label="Keep meeting audio"
                  hint="Days to keep the recording after notes are ready, so you can reprocess. 0 deletes it right away."
                >
                  <div className="flex items-center gap-2">
                    <TextInput
                      type="number"
                      width="w-20"
                      min={0}
                      max={3650}
                      step={1}
                      value={String(s.meetingRetainAudioDays)}
                      onChange={(v) => void patch({ meetingRetainAudioDays: clampInt(v, 0, 3650) })}
                    />
                    <span className="text-xs text-muted">days</span>
                  </div>
                </Field>
                <Field
                  label="AI notes"
                  hint="Draft a summary, decisions, and action items with the AI cleanup proxy. Transcript excerpts are sent to it."
                >
                  <Toggle checked={s.meetingNotes} onChange={(v) => void patch({ meetingNotes: v })} />
                </Field>
                <Field
                  label="Verify notes with TypeSafe JEV"
                  hint={
                    masked?.typesafeApiKey
                      ? 'Checks each note against the transcript. Transcript excerpts are sent to TypeSafe.'
                      : 'Add a TypeSafe API key below to check each note against the transcript.'
                  }
                >
                  <Toggle
                    checked={s.meetingVerifyNotes && Boolean(masked?.typesafeApiKey)}
                    disabled={!masked?.typesafeApiKey || !s.meetingNotes}
                    onChange={(v) => void patch({ meetingVerifyNotes: v })}
                  />
                </Field>
                <Field
                  label="Also show Windows notifications"
                  hint="Meeting states always show in Echo's bottom pill. Turn this on to also get a Windows notification when a meeting is detected, starts, ends, or its notes are ready."
                >
                  <Toggle checked={s.meetingNotifications} onChange={(v) => void patch({ meetingNotifications: v })} />
                </Field>
                <Field
                  label="TypeSafe API key"
                  hint={masked?.typesafeApiKey ? `Current: ${masked.typesafeApiKey}` : 'Not set'}
                >
                  <TextInput type="password" value={typesafeKey} placeholder="Enter to change" onChange={setTypesafeKey} />
                </Field>
                <div className="border-b border-border/50">
                  <button
                    onClick={() => setAdvanced((v) => !v)}
                    aria-expanded={advanced}
                    className="flex items-center gap-1.5 py-3 text-sm text-muted hover:text-text transition"
                  >
                    <ChevronRight className={`w-3.5 h-3.5 transition-transform duration-200 ${advanced ? 'rotate-90' : ''}`} />
                    Advanced
                  </button>
                  {advanced && (
                    <div className="pl-5">
                      <Field label="Live model" hint="Fast model for the transcript you see during the call.">
                        <DraftInput width="w-52" value={s.meetingLiveModel} onSave={(v) => patch({ meetingLiveModel: v.trim() })} />
                      </Field>
                      <Field label="Final model" hint="Most accurate model, run on the whole recording after the call.">
                        <DraftInput width="w-52" value={s.meetingFinalModel} onSave={(v) => patch({ meetingFinalModel: v.trim() })} />
                      </Field>
                      <Field label="Cross-check model" hint="Second opinion on the final pass that catches invented words.">
                        <DraftInput width="w-52" value={s.meetingCheckModel} onSave={(v) => patch({ meetingCheckModel: v.trim() })} />
                      </Field>
                      <Field label="Vocabulary model" hint="Spells names and terms from your dictionary and your meetings' people. Leave empty to turn it off.">
                        <DraftInput width="w-52" value={s.meetingVocabModel} onSave={(v) => patch({ meetingVocabModel: v.trim() })} />
                      </Field>
                    </div>
                  )}
                </div>
                <p className="py-3 text-xs text-muted">Recording laws vary; let participants know Echo is transcribing.</p>
              </>
            )}
          </Section>

          {api.platform === 'win32' && (
            <Section title="Calendar">
              <p className="py-3 text-xs text-muted">
                Echo reads your calendar to name the people in a meeting. Paste your calendar&apos;s private iCal address; no
                sign-in is needed, and it stays on this PC.
              </p>
              <Field
                label="Calendar address (iCal)"
                hint={masked?.calendarIcsUrl ? `Current: ${masked.calendarIcsUrl}` : 'Google: Settings › your calendar › Secret address in iCal format'}
              >
                <TextInput type="password" value={calendarUrl} placeholder="https://…/basic.ics" onChange={setCalendarUrl} />
              </Field>
              <Field label="My calendar email" hint="Leaves you out of a meeting's attendees. Optional when your name is set above.">
                <DraftInput width="w-52" value={s.meetingMyEmail} onSave={(v) => patch({ meetingMyEmail: v.trim() })} />
              </Field>
              <Field label="Test the calendar" hint="Reads it now and counts today's events.">
                <button
                  disabled={testingCalendar || !masked?.calendarIcsUrl}
                  onClick={() => {
                    setTestingCalendar(true)
                    api.meetings
                      .testCalendar()
                      .then(
                        (n) => notify(`Calendar read: ${n} event${n === 1 ? '' : 's'} today`),
                        (e) => notify(`Couldn't read the calendar: ${String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')}`)
                      )
                      .finally(() => setTestingCalendar(false))
                  }}
                  className="px-3 py-1.5 rounded-lg border border-border text-xs text-text hover:bg-surface2 transition disabled:opacity-50"
                >
                  {testingCalendar ? 'Reading…' : 'Test'}
                </button>
              </Field>
            </Section>
          )}

          <Section title="Behavior">
            <Field label="Launch at login">
              <Toggle checked={s.launchAtLogin} onChange={(v) => void patch({ launchAtLogin: v })} />
            </Field>
            <Field
              label="Microphone input"
              hint={
                s.audioInputDeviceId && !audioInputs.some((device) => device.deviceId === s.audioInputDeviceId)
                  ? 'Saved microphone is unavailable; using the system default.'
                  : 'Choose the input Echo records for dictation.'
              }
            >
              <Select
                value={s.audioInputDeviceId}
                onChange={(v) => void patch({ audioInputDeviceId: v })}
                options={[
                  { value: '', label: 'System default' },
                  ...audioInputs.map((device) => ({ value: device.deviceId, label: device.label }))
                ]}
              />
            </Field>
            <Field
              label="Mic activation"
              hint="On-demand opens the mic only while dictating. Keep warm removes first-press latency — the mic stays active in the background."
            >
              <Select
                value={s.micMode}
                onChange={(v) => void patch({ micMode: v })}
                options={[
                  { value: 'on-demand', label: 'On-demand' },
                  { value: 'warm', label: 'Keep warm' }
                ]}
              />
            </Field>
            <Field
              label="Keep audio recordings"
              hint="Save each dictation's audio so you can replay it from History. Uses disk space."
            >
              <Toggle checked={s.retainAudio} onChange={(v) => void patch({ retainAudio: v })} />
            </Field>
            <Field label="Overlay offset" hint="Distance of the pill from the bottom of the screen.">
              <div className="flex items-center gap-2">
                <TextInput
                  type="number"
                  width="w-20"
                  min={0}
                  max={400}
                  step={10}
                  value={String(s.overlayOffsetBottom)}
                  onChange={(v) => void patch({ overlayOffsetBottom: clampInt(v, 0, 400) })}
                />
                <span className="text-xs text-muted">px</span>
              </div>
            </Field>
          </Section>

          {(whisperKey || claudeKey || syncToken || typesafeKey || calendarUrl) && (
            <div className="py-4">
              <button
                onClick={() => void saveKeys()}
                className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium shadow-sm hover:bg-accent2 active:scale-[0.98] transition"
              >
                Save keys &amp; token
              </button>
            </div>
          )}
          <div className="h-8" />
        </div>
      </div>
    </div>
  )
}

function EndpointField({
  label,
  hint,
  value,
  required = false,
  serviceLabel,
  onSave
}: {
  label: string
  hint?: string
  value: string
  required?: boolean
  serviceLabel: string
  onSave: (value: string) => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  const errorId = useId()
  useEffect(() => setDraft(value), [value])
  const validation = validateEndpointUrl(draft, { required, label: serviceLabel })
  const commit = (): void => {
    if (!validation.error && validation.normalized !== value) void onSave(validation.normalized)
  }
  return (
    <Field label={label} hint={hint} error={validation.error} errorId={errorId}>
      <TextInput
        value={draft}
        onChange={setDraft}
        invalid={Boolean(validation.error)}
        describedBy={validation.error ? errorId : undefined}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
    </Field>
  )
}

/** A text setting saved on blur or Enter, so typing a path or name does not persist every keystroke. */
function DraftInput({
  value,
  placeholder,
  width,
  onSave
}: {
  value: string
  placeholder?: string
  width?: string
  onSave: (value: string) => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <TextInput
      width={width}
      value={draft}
      placeholder={placeholder}
      onChange={setDraft}
      onBlur={() => {
        if (draft !== value) void onSave(draft)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="py-3">
      <h2 className="text-xs uppercase tracking-wider text-muted mb-2 px-1">{title}</h2>
      <div className="bg-surface border border-border rounded-xl px-4">{children}</div>
    </div>
  )
}

function clampInt(v: string, min: number, max: number): number {
  const n = parseInt(v || '0', 10)
  if (Number.isNaN(n)) return min
  return Math.max(min, Math.min(max, n))
}
