import { ipcMain, clipboard, dialog } from 'electron'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { parseDictionaryImport, serializeDictionary } from '@shared/dict-export'
import { serializeTranscriptCsv, serializeTranscriptJson } from '@shared/transcript-export'
import {
  IPC,
  type AudioMeta,
  type DiagName,
  type DictionaryImportResult,
  type EditResult,
  type LearnedCorrection,
  type HistoryQueryOpts,
  type Secrets,
  type Settings
} from '@shared/types'
import type { SettingsStore } from './store/settings'
import type { HistoryStore } from './store/history'
import type { DictionaryStore } from './store/dictionary'
import type { DictationController } from './dictation'
import type { HotkeyListener } from './hotkey/listener'
import { cleanup } from './transcription/claude'
import { realPasteDeps } from './insert/paste-deps'
import { pasteText } from './insert/paste'
import { runDiagnostic } from './diagnostics'
import { createDiagnosticReport } from './diagnostic-report'
import { learnFromEdit } from './learn'
import { writeFileAtomic } from './store/atomic-file'

export interface IpcContext {
  settings: SettingsStore
  history: HistoryStore
  dictionary: DictionaryStore
  controller: DictationController
  listener: HotkeyListener
  openDashboard: () => void
  onSettingsChanged: (s: Settings) => void
}

export function registerIpc(ctx: IpcContext): void {
  ipcMain.on(IPC.OVERLAY_READY, () => {
    /* overlay handshake — reserved for future pre-warming */
  })

  // ── Hot path: overlay sends the recorded audio, we transcribe + insert ──────
  ipcMain.handle(IPC.DICTATION_AUDIO, (_e, buf: ArrayBuffer, meta: AudioMeta) =>
    ctx.controller.handleAudio(buf, meta)
  )

  // ── History ─────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.HISTORY_LIST, (_e, opts: HistoryQueryOpts) => ctx.history.list(opts))
  ipcMain.handle(IPC.HISTORY_SEARCH, (_e, q: string, opts: HistoryQueryOpts) => ctx.history.search(q, opts))
  ipcMain.handle(IPC.HISTORY_DELETE, (_e, id: number) => {
    const t = ctx.history.get(id)
    if (t?.audio_path) {
      try {
        unlinkSync(t.audio_path)
      } catch {
        /* file already gone */
      }
    }
    ctx.history.delete(id)
  })
  ipcMain.handle(IPC.HISTORY_STATS, () => ctx.history.stats(Date.now()))
  ipcMain.handle(IPC.HISTORY_AUDIO, (_e, id: number): ArrayBuffer | null => {
    const t = ctx.history.get(id)
    if (!t?.audio_path) return null
    try {
      const buf = readFileSync(t.audio_path)
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    } catch {
      return null
    }
  })
  ipcMain.handle(IPC.HISTORY_COPY, (_e, id: number) => {
    const t = ctx.history.get(id)
    if (t) clipboard.writeText(t.cleaned_text ?? t.raw_text)
  })
  ipcMain.handle(IPC.HISTORY_EXPORT_JSON, async (): Promise<string | null> => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export transcript history',
      defaultPath: 'echo-transcripts.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return null
    const exported = serializeTranscriptJson(ctx.history.listAll())
    writeFileAtomic(filePath, JSON.stringify(exported, null, 2))
    return filePath
  })
  ipcMain.handle(IPC.HISTORY_EXPORT_CSV, async (): Promise<string | null> => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export transcript history',
      defaultPath: 'echo-transcripts.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return null
    writeFileAtomic(filePath, serializeTranscriptCsv(ctx.history.listAll()))
    return filePath
  })
  ipcMain.handle(IPC.HISTORY_CLEAR_UNSUCCESSFUL, async (): Promise<number | null> => {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Clear unsuccessful attempts?',
      message: 'Clear all failed and empty transcript attempts?',
      detail: 'Successful transcripts will not be changed.',
      buttons: ['Clear attempts', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    if (response !== 0) return null
    const removed = ctx.history.clearUnsuccessful()
    for (const transcript of removed) {
      if (!transcript.audio_path) continue
      try {
        unlinkSync(transcript.audio_path)
      } catch {
        /* file already gone */
      }
    }
    return removed.length
  })
  ipcMain.handle(IPC.HISTORY_REINSERT, async (_e, id: number) => {
    const t = ctx.history.get(id)
    if (!t) return { ok: false, error: 'Transcript not found' }
    await pasteText(t.cleaned_text ?? t.raw_text, realPasteDeps())
    return { ok: true, transcript: t }
  })
  ipcMain.handle(IPC.HISTORY_RETRY, (_e, id: number) => ctx.controller.retryTranscript(id))
  ipcMain.handle(IPC.HISTORY_POLISH, async (_e, id: number) => {
    const t = ctx.history.get(id)
    if (!t) throw new Error('Transcript not found')
    const s = ctx.settings.getSettings()
    const sec = ctx.settings.getSecrets()
    const glossary = ctx.dictionary.list().map((e) => e.word)
    const cleaned = await cleanup(t.raw_text || t.cleaned_text || '', s, sec.claudeApiKey, undefined, glossary)
    return ctx.history.updateCleaned(id, cleaned)
  })
  ipcMain.handle(IPC.HISTORY_EDIT, (_e, id: number, text: string): EditResult => {
    const before = ctx.history.get(id)
    if (!before) throw new Error('Transcript not found')
    const displayed = before.cleaned_text ?? before.raw_text
    const transcript = ctx.history.updateEdited(id, text)
    if (!transcript) throw new Error('Transcript not found')
    let learned: LearnedCorrection[] = []
    try {
      learned = learnFromEdit(ctx.dictionary, displayed, text)
    } catch {
      /* learning must never block the edit itself */
    }
    return { transcript, learned }
  })

  // ── Dictionary ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.DICT_LIST, () => ctx.dictionary.list())
  ipcMain.handle(IPC.DICT_ADD, (_e, word: string, misheard: string[]) =>
    ctx.dictionary.add(word, misheard, 'manual')
  )
  ipcMain.handle(IPC.DICT_UPDATE, (_e, id: number, patch: { word?: string; misheard?: string[] }) =>
    ctx.dictionary.update(id, patch)
  )
  ipcMain.handle(IPC.DICT_DELETE, (_e, id: number) => ctx.dictionary.delete(id))
  ipcMain.handle(IPC.DICT_UNDO_LEARN, (_e, items: LearnedCorrection[]) => {
    for (const item of items) {
      if (item.createdEntry) ctx.dictionary.delete(item.entryId)
      else ctx.dictionary.removeAlias(item.entryId, item.from)
    }
  })
  ipcMain.handle(IPC.DICT_EXPORT, async (): Promise<string | null> => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export dictionary',
      defaultPath: 'echo-dictionary.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return null
    writeFileSync(filePath, JSON.stringify(serializeDictionary(ctx.dictionary.list()), null, 2))
    return filePath
  })
  ipcMain.handle(IPC.DICT_IMPORT, async (): Promise<DictionaryImportResult | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import dictionary',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePaths[0]) return null
    const raw = readFileSync(filePaths[0], 'utf8')
    if (Buffer.byteLength(raw) > 5 * 1024 * 1024) throw new Error('Dictionary import is larger than 5 MB')
    const parsed = parseDictionaryImport(raw)
    for (const entry of parsed.entries) {
      ctx.dictionary.add(entry.word, entry.misheard, entry.source)
    }
    return { imported: parsed.entries.length, skipped: parsed.skipped }
  })

  // ── Settings + secrets ────────────────────────────────────────────────────────
  ipcMain.handle(IPC.SETTINGS_GET, () => ctx.settings.getSettings())
  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch: Partial<Settings>) => {
    const next = ctx.settings.setSettings(patch)
    ctx.onSettingsChanged(next)
    return next
  })
  ipcMain.handle(IPC.SECRETS_GET_MASKED, () => ctx.settings.getMaskedSecrets())
  ipcMain.handle(IPC.SECRETS_SET, (_e, patch: Partial<Secrets>) => {
    ctx.settings.setSecrets(patch)
  })

  // ── Diagnostics + misc ─────────────────────────────────────────────────────────
  ipcMain.handle(IPC.DIAG_RUN, (_e, name: DiagName) =>
    runDiagnostic(name, ctx.settings, ctx.listener.isRunning)
  )
  ipcMain.handle(IPC.DIAG_COPY_REPORT, (_e, results: import('@shared/types').DiagResult[]) => {
    const settings = ctx.settings.getSettings()
    const secrets = ctx.settings.getSecrets()
    const report = createDiagnosticReport({
      platform: process.platform,
      arch: process.arch,
      packaged: process.defaultApp !== true,
      triggerKey: settings.triggerKey,
      hotkeyRunning: ctx.listener.isRunning,
      endpoints: {
        whisper: Boolean(settings.whisperBaseUrl),
        cleanup: Boolean(settings.claudeBaseUrl),
        sync: Boolean(settings.syncBaseUrl)
      },
      secrets: {
        whisper: Boolean(secrets.whisperApiKey),
        cleanup: Boolean(secrets.claudeApiKey),
        sync: Boolean(secrets.syncToken)
      },
      results: Array.isArray(results) ? results : []
    })
    clipboard.writeText(report)
  })
  ipcMain.handle(IPC.OPEN_DASHBOARD, () => {
    ctx.openDashboard()
  })
}
