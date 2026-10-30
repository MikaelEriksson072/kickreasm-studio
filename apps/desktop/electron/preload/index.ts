/* Preload (sandboxed): exposes the narrow, typed `window.kr` API (spec 4.1). It never exposes
 * ipcRenderer itself; arguments get a cheap shape check here and full validation in main. */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNELS, type FsChangedEvent, type InvokeChannel, type KrApi, type QuicksaveEvent } from '../../shared/ipc';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function invoke<T>(channel: InvokeChannel, arg?: unknown): Promise<T> {
  if (arg !== undefined && !isObj(arg)) return Promise.reject(new TypeError(`${channel}: expected an object argument`));
  return ipcRenderer.invoke(channel, arg) as Promise<T>;
}

const api: KrApi = {
  openProject: req => invoke(CHANNELS.projectOpen, req ?? {}),
  saveProject: req => invoke(CHANNELS.projectSave, req),
  openPrg: req => invoke(CHANNELS.prgOpen, req ?? {}),
  openDisk: req => invoke(CHANNELS.diskOpen, req ?? {}),
  writeExport: req => invoke(CHANNELS.exportWrite, req),
  build: req => invoke(CHANNELS.toolchainBuild, req),
  run: req => invoke(CHANNELS.toolchainRun, req),
  openTerminal: req => invoke(CHANNELS.terminalOpen, req ?? {}),
  unpack: req => invoke(CHANNELS.toolchainUnpack, req),
  identifyPacker: req => invoke(CHANNELS.toolchainIdentify, req),
  pack: req => invoke(CHANNELS.toolchainPack, req),
  saveFile: req => invoke(CHANNELS.fileSave, req),
  viceAttach: req => invoke(CHANNELS.viceAttach, req ?? {}),
  viceCommand: req => invoke(CHANNELS.viceCommand, req),
  openQuicksave: req => invoke(CHANNELS.viceQuicksave, req ?? {}),
  quicksaveInfo: () => invoke(CHANNELS.viceQuicksaveInfo),
  quicksaves: () => invoke(CHANNELS.viceQuicksaves),
  openQuicksaveEntry: req => invoke(CHANNELS.viceQuicksaveOpen, req),
  renameQuicksave: req => invoke(CHANNELS.viceQuicksaveRename, req),
  saveQuicksave: req => invoke(CHANNELS.viceQuicksaveSave, req),
  favouriteQuicksave: req => invoke(CHANNELS.viceQuicksaveFavourite, req),
  charRom: () => invoke(CHANNELS.viceCharRom),
  onQuicksave: cb => {
    if (typeof cb !== 'function') throw new TypeError('onQuicksave expects a function');
    const listener = (_e: IpcRendererEvent, data: QuicksaveEvent) => cb({ path: String(data?.path ?? ''), saved: Number(data?.saved) || 0 });
    ipcRenderer.on(CHANNELS.viceQuicksaved, listener);
    return () => { ipcRenderer.removeListener(CHANNELS.viceQuicksaved, listener); };
  },
  getSettings: () => invoke(CHANNELS.settingsGet),
  setSettings: patch => invoke(CHANNELS.settingsSet, patch),
  onFsChanged: cb => {
    if (typeof cb !== 'function') throw new TypeError('onFsChanged expects a function');
    const listener = (_e: IpcRendererEvent, data: FsChangedEvent) => cb({ path: String(data?.path ?? '') });
    ipcRenderer.on(CHANNELS.fsChanged, listener);
    return () => { ipcRenderer.removeListener(CHANNELS.fsChanged, listener); };
  },
};

contextBridge.exposeInMainWorld('kr', api);
