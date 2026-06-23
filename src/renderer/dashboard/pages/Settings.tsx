import { useEffect, useState, type ReactNode } from 'react'
import type { MaskedSecrets, Settings as SettingsType } from '@shared/types'
import { triggerLabel, triggerOptions } from '@shared/trigger'
import { api } from '../lib/api'
import { Field, TextInput, Select } from '../components/Field'
import { Toggle } from '../components/Toggle'

export function Settings({ notify }: { notify: (m: string) => void }): JSX.Element {
  const [s, setS] = useState<SettingsType | null>(null)
  const [masked, setMasked] = useState<MaskedSecrets | null>(null)
  const [whisperKey, setWhisperKey] = useState('')
  const [claudeKey, setClaudeKey] = useState('')
  const [syncToken, setSyncToken] = useState('')

  useEffect(() => {
    void (async () => {
      setS(await api.settings.get())
      setMasked(await api.settings.getSecretsMasked())
    })()
  }, [])

  if (!s) return <div className="p-7 text-muted text-sm">Loading…</div>

  const patch = async (p: Partial<SettingsType>): Promise<void> => {
    setS(await api.settings.set(p))
  }

  const saveKeys = async (): Promise<void> => {
    const body: Partial<{ whisperApiKey: string; claudeApiKey: string; syncToken: string }> = {}
    if (whisperKey) body.whisperApiKey = whisperKey
    if (claudeKey) body.claudeApiKey = claudeKey
    if (syncToken) body.syncToken = syncToken
    if (Object.keys(body).length === 0) return
    await api.settings.setSecrets(body)
    setWhisperKey('')
    setClaudeKey('')
    setSyncToken('')
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
          </Section>

          <Section title="Transcription (Whisper)">
            <Field label="Base URL">
              <TextInput value={s.whisperBaseUrl} onChange={(v) => void patch({ whisperBaseUrl: v })} />
            </Field>
            <Field label="Model">
              <TextInput width="w-44" value={s.whisperModel} onChange={(v) => void patch({ whisperModel: v })} />
            </Field>
            <Field label="API key" hint={masked?.whisperApiKey ? `Current: ${masked.whisperApiKey}` : 'Not set'}>
              <TextInput type="password" value={whisperKey} placeholder="Enter to change" onChange={setWhisperKey} />
            </Field>
          </Section>

          <Section title="AI cleanup (Claude)">
            <Field
              label="Cleanup mode"
              hint="Raw = fastest. On-demand = polish from history. Auto = clean every dictation before inserting."
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
            <Field label="Base URL">
              <TextInput value={s.claudeBaseUrl} onChange={(v) => void patch({ claudeBaseUrl: v })} />
            </Field>
            <Field label="Model">
              <TextInput width="w-52" value={s.claudeModel} onChange={(v) => void patch({ claudeModel: v })} />
            </Field>
            <Field label="API key" hint={masked?.claudeApiKey ? `Current: ${masked.claudeApiKey}` : 'Not set'}>
              <TextInput type="password" value={claudeKey} placeholder="Enter to change" onChange={setClaudeKey} />
            </Field>
          </Section>

          <Section title="Sync">
            <Field
              label="Service URL"
              hint="Your self-hosted sync service (e.g. on your tailnet). Leave blank to keep this device local-only."
            >
              <TextInput value={s.syncBaseUrl} onChange={(v) => void patch({ syncBaseUrl: v })} />
            </Field>
            <Field label="Token" hint={masked?.syncToken ? `Current: ${masked.syncToken}` : 'Not set'}>
              <TextInput type="password" value={syncToken} placeholder="Enter to change" onChange={setSyncToken} />
            </Field>
          </Section>

          <Section title="Behavior">
            <Field label="Launch at login">
              <Toggle checked={s.launchAtLogin} onChange={(v) => void patch({ launchAtLogin: v })} />
            </Field>
            <Field
              label="Microphone"
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

          {(whisperKey || claudeKey || syncToken) && (
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
