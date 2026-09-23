import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AudioMeta,
  type DiagName,
  type DictationStateEvent,
  type LearnedCorrection,
  type HistoryQueryOpts,
  type EchoApi,
  type OSPlatform,
  type Secrets,
  type Settings
} from '@shared/types'
import { MEETINGS_IPC, type MeetingEvent } from '@shared/meeting-types'

const api: EchoApi = {
  platform: process.platform as OSPlatform,
  onDictationState(cb) {
    const listener = (_e: IpcRendererEvent, data: DictationStateEvent): void => cb(data)
    ipcRenderer.on(IPC.DICTATION_STATE, listener)
    return () => ipcRenderer.removeListener(IPC.DICTATION_STATE, listener)
  },
  onSettingsChanged(cb) {
    const listener = (_e: IpcRendererEvent, data: Settings): void => cb(data)
    ipcRenderer.on(IPC.SETTINGS_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.SETTINGS_CHANGED, listener)
  },
  sendAudio(buf: ArrayBuffer, meta: AudioMeta) {
    return ipcRenderer.invoke(IPC.DICTATION_AUDIO, buf, meta)
  },
  previewAudio(buf: ArrayBuffer) {
    return ipcRenderer.invoke(IPC.DICTATION_PREVIEW, buf)
  },
  overlayReady() {
    ipcRenderer.send(IPC.OVERLAY_READY)
  },
  logMic(event: string) {
    ipcRenderer.send(IPC.OVERLAY_MIC_LOG, event)
  },
  setOverlayInteractive(interactive: boolean) {
    ipcRenderer.send(IPC.OVERLAY_INTERACTIVE, interactive)
  },
  history: {
    list: (opts: HistoryQueryOpts) => ipcRenderer.invoke(IPC.HISTORY_LIST, opts),
    search: (q: string, opts: HistoryQueryOpts) => ipcRenderer.invoke(IPC.HISTORY_SEARCH, q, opts),
    delete: (id: number) => ipcRenderer.invoke(IPC.HISTORY_DELETE, id),
    stats: () => ipcRenderer.invoke(IPC.HISTORY_STATS),
    polish: (id: number) => ipcRenderer.invoke(IPC.HISTORY_POLISH, id),
    edit: (id: number, text: string) => ipcRenderer.invoke(IPC.HISTORY_EDIT, id, text),
    reinsert: (id: number) => ipcRenderer.invoke(IPC.HISTORY_REINSERT, id),
    retry: (id: number) => ipcRenderer.invoke(IPC.HISTORY_RETRY, id),
    copy: (id: number) => ipcRenderer.invoke(IPC.HISTORY_COPY, id),
    getAudio: (id: number) => ipcRenderer.invoke(IPC.HISTORY_AUDIO, id),
    exportJson: (filter) => ipcRenderer.invoke(IPC.HISTORY_EXPORT_JSON, filter),
    exportCsv: (filter) => ipcRenderer.invoke(IPC.HISTORY_EXPORT_CSV, filter),
    clearUnsuccessful: () => ipcRenderer.invoke(IPC.HISTORY_CLEAR_UNSUCCESSFUL)
  },
  dictionary: {
    list: () => ipcRenderer.invoke(IPC.DICT_LIST),
    add: (word: string, misheard: string[]) => ipcRenderer.invoke(IPC.DICT_ADD, word, misheard),
    update: (id: number, patch: { word?: string; misheard?: string[] }) =>
      ipcRenderer.invoke(IPC.DICT_UPDATE, id, patch),
    remove: (id: number) => ipcRenderer.invoke(IPC.DICT_DELETE, id),
    undoLearn: (items: LearnedCorrection[]) => ipcRenderer.invoke(IPC.DICT_UNDO_LEARN, items),
    export: () => ipcRenderer.invoke(IPC.DICT_EXPORT),
    import: () => ipcRenderer.invoke(IPC.DICT_IMPORT)
  },
  snippets: {
    list: () => ipcRenderer.invoke(IPC.SNIPPET_LIST),
    add: (cue, expansion) => ipcRenderer.invoke(IPC.SNIPPET_ADD, cue, expansion),
    update: (id, patch) => ipcRenderer.invoke(IPC.SNIPPET_UPDATE, id, patch),
    remove: (id) => ipcRenderer.invoke(IPC.SNIPPET_DELETE, id)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
    getSecretsMasked: () => ipcRenderer.invoke(IPC.SECRETS_GET_MASKED),
    setSecrets: (patch: Partial<Secrets>) => ipcRenderer.invoke(IPC.SECRETS_SET, patch)
  },
  diag: {
    run: (name: DiagName) => ipcRenderer.invoke(IPC.DIAG_RUN, name),
    copyReport: (results) => ipcRenderer.invoke(IPC.DIAG_COPY_REPORT, results)
  },
  system: {
    buildInfo: () => ipcRenderer.invoke(IPC.SYSTEM_BUILD_INFO)
  },
  meetings: {
    list: () => ipcRenderer.invoke(MEETINGS_IPC.LIST),
    get: (id) => ipcRenderer.invoke(MEETINGS_IPC.GET, id),
    live: () => ipcRenderer.invoke(MEETINGS_IPC.LIVE),
    stop: () => ipcRenderer.invoke(MEETINGS_IPC.STOP),
    discard: () => ipcRenderer.invoke(MEETINGS_IPC.DISCARD),
    startNow: () => ipcRenderer.invoke(MEETINGS_IPC.START_NOW),
    testCalendar: () => ipcRenderer.invoke(MEETINGS_IPC.TEST_CALENDAR),
    setMicPaused: (paused) => ipcRenderer.invoke(MEETINGS_IPC.SET_MIC_PAUSED, paused),
    remove: (id) => ipcRenderer.invoke(MEETINGS_IPC.REMOVE, id),
    renameSpeaker: (id, speakerKey, name, remember) =>
      ipcRenderer.invoke(MEETINGS_IPC.RENAME_SPEAKER, id, speakerKey, name, remember),
    reprocess: (id) => ipcRenderer.invoke(MEETINGS_IPC.REPROCESS, id),
    exportFile: (id, format) => ipcRenderer.invoke(MEETINGS_IPC.EXPORT, id, format),
    openFolder: (id) => ipcRenderer.invoke(MEETINGS_IPC.OPEN_FOLDER, id),
    people: () => ipcRenderer.invoke(MEETINGS_IPC.PEOPLE),
    forgetPerson: (personId) => ipcRenderer.invoke(MEETINGS_IPC.FORGET_PERSON, personId),
    show: (id) => ipcRenderer.invoke(MEETINGS_IPC.SHOW, id),
    onEvent(cb) {
      const listener = (_e: IpcRendererEvent, data: MeetingEvent): void => cb(data)
      ipcRenderer.on(MEETINGS_IPC.EVENT, listener)
      return () => {
        ipcRenderer.removeListener(MEETINGS_IPC.EVENT, listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
