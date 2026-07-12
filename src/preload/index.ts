import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AudioMeta,
  type DiagName,
  type DictationStateEvent,
  type LearnedCorrection,
  type ListOpts,
  type EchoApi,
  type OSPlatform,
  type Secrets,
  type Settings
} from '@shared/types'

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
  overlayReady() {
    ipcRenderer.send(IPC.OVERLAY_READY)
  },
  history: {
    list: (opts: ListOpts) => ipcRenderer.invoke(IPC.HISTORY_LIST, opts),
    search: (q: string, opts: ListOpts) => ipcRenderer.invoke(IPC.HISTORY_SEARCH, q, opts),
    delete: (id: number) => ipcRenderer.invoke(IPC.HISTORY_DELETE, id),
    stats: () => ipcRenderer.invoke(IPC.HISTORY_STATS),
    polish: (id: number) => ipcRenderer.invoke(IPC.HISTORY_POLISH, id),
    edit: (id: number, text: string) => ipcRenderer.invoke(IPC.HISTORY_EDIT, id, text),
    reinsert: (id: number) => ipcRenderer.invoke(IPC.HISTORY_REINSERT, id),
    retry: (id: number) => ipcRenderer.invoke(IPC.HISTORY_RETRY, id),
    copy: (id: number) => ipcRenderer.invoke(IPC.HISTORY_COPY, id),
    getAudio: (id: number) => ipcRenderer.invoke(IPC.HISTORY_AUDIO, id),
    exportJson: () => ipcRenderer.invoke(IPC.HISTORY_EXPORT_JSON)
  },
  dictionary: {
    list: () => ipcRenderer.invoke(IPC.DICT_LIST),
    add: (word: string, misheard: string[]) => ipcRenderer.invoke(IPC.DICT_ADD, word, misheard),
    update: (id: number, patch: { word?: string; misheard?: string[] }) =>
      ipcRenderer.invoke(IPC.DICT_UPDATE, id, patch),
    remove: (id: number) => ipcRenderer.invoke(IPC.DICT_DELETE, id),
    undoLearn: (items: LearnedCorrection[]) => ipcRenderer.invoke(IPC.DICT_UNDO_LEARN, items),
    export: () => ipcRenderer.invoke(IPC.DICT_EXPORT)
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
  }
}

contextBridge.exposeInMainWorld('api', api)
