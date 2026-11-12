import { contextBridge, ipcRenderer } from 'electron';

import { type DesktopApi, type DesktopStatus, INVOKE_CHANNELS, STATUS_CHANNEL } from '../api';

/**
 * The window's only door into main: `window.marketMaker`, one method per `DesktopApi` call, each
 * bound to its own channel. No generic `send`/`invoke` is exposed, so a compromised page can reach
 * nothing else.
 *
 * IMPLEMENTATION NOTE: `contextBridge.exposeInMainWorld` copies the API object into the isolated
 * page world; functions stay callable across the bridge and promises resolve there
 * (https://www.electronjs.org/docs/latest/api/context-bridge). `ipcRenderer.invoke` pairs with
 * `ipcMain.handle` (https://www.electronjs.org/docs/latest/api/ipc-renderer). The listener passed
 * to `onStatus` receives only the status, never the `IpcRendererEvent`, which would expose
 * `ipcRenderer` itself (https://www.electronjs.org/docs/latest/tutorial/context-isolation).
 */
const api: DesktopApi = {
  status: () => ipcRenderer.invoke(INVOKE_CHANNELS.status),
  importKey: (privateKey) => ipcRenderer.invoke(INVOKE_CHANNELS.importKey, privateKey),
  removeKey: () => ipcRenderer.invoke(INVOKE_CHANNELS.removeKey),
  loadTasks: () => ipcRenderer.invoke(INVOKE_CHANNELS.loadTasks),
  saveTasks: (text) => ipcRenderer.invoke(INVOKE_CHANNELS.saveTasks, text),
  start: () => ipcRenderer.invoke(INVOKE_CHANNELS.start),
  stop: () => ipcRenderer.invoke(INVOKE_CHANNELS.stop),
  cancelAll: () => ipcRenderer.invoke(INVOKE_CHANNELS.cancelAll),
  approveWeth: (amount, venue) => ipcRenderer.invoke(INVOKE_CHANNELS.approveWeth, amount, venue),
  cancelAllListings: () => ipcRenderer.invoke(INVOKE_CHANNELS.cancelAllListings),
  importOpenSeaKey: (apiKey) => ipcRenderer.invoke(INVOKE_CHANNELS.importOpenSeaKey, apiKey),
  removeOpenSeaKey: () => ipcRenderer.invoke(INVOKE_CHANNELS.removeOpenSeaKey),
  saveRpcUrl: (url) => ipcRenderer.invoke(INVOKE_CHANNELS.saveRpcUrl, url),
  removeRpcUrl: () => ipcRenderer.invoke(INVOKE_CHANNELS.removeRpcUrl),
  balances: () => ipcRenderer.invoke(INVOKE_CHANNELS.balances),
  profile: () => ipcRenderer.invoke(INVOKE_CHANNELS.profile),
  collections: () => ipcRenderer.invoke(INVOKE_CHANNELS.collections),
  searchCollections: (query) => ipcRenderer.invoke(INVOKE_CHANNELS.searchCollections, query),
  onStatus: (listener) => {
    const forward = (_event: unknown, status: DesktopStatus) => listener(status);
    ipcRenderer.on(STATUS_CHANNEL, forward);
    return () => ipcRenderer.removeListener(STATUS_CHANNEL, forward);
  },
};

contextBridge.exposeInMainWorld('marketMaker', api);
