/* Registers the IPC allowlist (spec 13.4). Every request is checked for a trusted sender and
 * validated with zod before it touches the file system or starts a process. */
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type OpenDialogOptions, type WebContents } from 'electron';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z, type ZodTypeAny } from 'zod';
import { CHANNELS, type InvokeChannel, type ExportWriteResult, type FileSaveResult, type ProjectOpenResult, type ProjectSaveResult } from '../../shared/ipc';
import type { PathPolicy } from './paths';
import type { RecentFolders, RecentKind } from './recent';
import type { SettingsStore } from './settings';
import { createBuildFolder, readDiskImage, readPrgFiles, readProjectFile, writeExportFolder, writeProjectFile, type ExportWatcher } from './project-fs';
import { buildWithKickAssembler, c64Roms, identifyWithTool, openTerminal, packWithBrokkr, packWithExomizer, runInVice, unpackWithTool } from './toolchain';
import { viceAttach, viceCommand } from './vice-monitor';
import { quicksaveFileName, quicksaveFiles, quicksaveInfo, readQuicksave, type QuicksaveHistory, type QuicksaveWatcher } from './quicksave';
import { charRomFiles, readCharRom } from './chargen';
import { openC64File } from '@mimir/core';
import { openedPrg } from './project-fs';
import {
  buildSchema, diskOpenSchema, exportWriteSchema, fileSaveSchema, packSchema, prgOpenSchema, projectOpenSchema, projectSaveSchema, quicksaveEntrySchema, quicksaveFavouriteSchema, quicksaveRenameSchema, quicksaveSaveSchema,
  quicksaveSchema, runSchema, terminalOpenSchema, unpackSchema, toolchainSettingsSchema, viceAttachSchema, viceCommandSchema,
} from './schemas';

export interface IpcDeps {
  policy: PathPolicy;
  settings: SettingsStore;
  watcher: ExportWatcher;
  /** the folder each dialog was last used in (they open there again, also after a restart) */
  recent: RecentFolders;
  /** true for the app's own renderer (dev server or the packaged index.html) */
  isTrustedUrl: (url: string) => boolean;
  /** watches VICE's quicksave snapshot (the files follow the setting) */
  quicksave: QuicksaveWatcher;
  /** the newest quicksaves, kept with names */
  history: QuicksaveHistory;
}

const windowOf = (wc: WebContents) => BrowserWindow.fromWebContents(wc) ?? undefined;

/** what the save dialog calls a file, by its extension */
const SAVE_KINDS: Record<string, string> = {
  prg: 'C64 program', bin: 'Binary data', '64c': 'Charset with load address', kla: 'Koala Painter picture', art: 'Art Studio picture',
  png: 'PNG image', asm: 'Kick Assembler source',
};

async function pickPaths(e: IpcMainInvokeEvent, options: OpenDialogOptions): Promise<string[]> {
  const win = windowOf(e.sender);
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return r.canceled ? [] : r.filePaths;
}

export function registerIpc(deps: IpcDeps): void {
  const { policy, settings, watcher, recent, quicksave, history } = deps;
  quicksave.watch(quicksaveFiles(settings.get().viceQuicksave));
  // the quicksave there is now (from before the app started, or in a newly set file) joins the kept ones
  const keepCurrent = () => quicksaveInfo(quicksaveFiles(settings.get().viceQuicksave)).then(i => (i.found && i.saved ? history.add(i.path, i.saved) : null)).catch(() => null);
  let kept = keepCurrent();
  /** the folder last picked in a dialog: where the terminal opens when the renderer names none */
  let lastChosen: string | null = null;
  /** a folder the user picked: allowed for this session, and where this kind of dialog opens next time */
  const chose = (dir: string, kind: RecentKind, remember = dir) => { lastChosen = policy.allow(dir); recent.remember(kind, remember); return lastChosen; };
  const pick = (e: IpcMainInvokeEvent, kind: RecentKind, options: OpenDialogOptions) => {
    const start = recent.folder(kind);
    return pickPaths(e, start ? { ...options, defaultPath: start } : options);
  };

  const handle = <S extends ZodTypeAny>(channel: InvokeChannel, schema: S, fn: (req: z.output<S>, e: IpcMainInvokeEvent) => Promise<unknown> | unknown) => {
    ipcMain.handle(channel, async (e, raw: unknown) => {
      if (!deps.isTrustedUrl(e.senderFrame?.url ?? '')) throw new Error(`${channel}: request from an untrusted page`);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`${channel}: invalid request (${issue?.path.join('.') || 'value'}: ${issue?.message})`);
      }
      return fn(parsed.data, e);
    });
  };

  handle(CHANNELS.projectOpen, projectOpenSchema, async (req, e): Promise<ProjectOpenResult | null> => {
    let path = req.path ? policy.assert(req.path, 'Project file') : null;
    if (!path) {
      const [picked] = await pick(e, 'project', { title: 'Open Mimir project', properties: ['openFile'], filters: [{ name: 'Mimir project', extensions: ['json'] }] });
      if (!picked) return null;
      path = picked;
      chose(dirname(path), 'project');
    }
    return { path, project: await readProjectFile(path) };
  });

  handle(CHANNELS.projectSave, projectSaveSchema, async (req, e): Promise<ProjectSaveResult | null> => {
    let path = req.path && policy.isAllowed(req.path) ? req.path : null;
    if (!path) {
      const win = windowOf(e.sender);
      const start = recent.folder('project'), file = `${req.project.name}.mimir.json`;
      const options = { title: 'Save Mimir project', defaultPath: start ? join(start, file) : file, filters: [{ name: 'Mimir project', extensions: ['json'] }] };
      const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (r.canceled || !r.filePath) return null;
      path = r.filePath;
      chose(dirname(path), 'project');
    }
    await writeProjectFile(path, req.project);
    return { path };
  });

  handle(CHANNELS.prgOpen, prgOpenSchema, async (req, e) => {
    let paths = req.paths?.map(p => policy.assert(p, 'PRG file')) ?? [];
    if (!req.paths?.length) {
      paths = await pick(e, 'prg', { title: 'Open PRG files', properties: ['openFile', 'multiSelections'], filters: [{ name: 'C64 programs and VICE snapshots', extensions: ['prg', 'PRG', 'vsf', 'VSF'] }, { name: 'All files', extensions: ['*'] }] });
      for (const p of paths) chose(dirname(p), 'prg');
    }
    return readPrgFiles(paths, { zeroPage: req.zeroPage });
  });

  handle(CHANNELS.diskOpen, diskOpenSchema, async (req, e) => {
    let path = req.path ? policy.assert(req.path, 'Disk image') : null;
    if (!path) {
      [path] = await pick(e, 'disk', { title: 'Mount D64 disk image', properties: ['openFile'], filters: [{ name: 'C64 disk images', extensions: ['d64', 'D64'] }, { name: 'All files', extensions: ['*'] }] });
      if (!path) return null;
      chose(dirname(path), 'disk');
    }
    return readDiskImage(path);
  });

  handle(CHANNELS.exportWrite, exportWriteSchema, async (req, e): Promise<ExportWriteResult | null> => {
    let dir: string;
    if (req.target === 'temp') dir = policy.allow(await createBuildFolder(req.name ?? 'build'));
    else if (req.target === 'pick') {
      const [picked] = await pick(e, 'export', { title: 'Export Kick Assembler project to folder', properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
      if (!picked) return null;
      // the next export dialog opens in the folder around this one, so a new export can go next to it
      dir = chose(picked, 'export', dirname(picked));
    } else dir = policy.assert(req.dir!, 'Export folder');
    watcher.touched(dir);
    const written = await writeExportFolder(dir, req.files);
    if (req.target !== 'temp') watcher.watch(dir);
    return { dir, written };
  });

  handle(CHANNELS.toolchainBuild, buildSchema, req => buildWithKickAssembler(req, settings.get(), policy));
  handle(CHANNELS.toolchainRun, runSchema, req => runInVice(req, settings.get(), policy));
  handle(CHANNELS.toolchainUnpack, unpackSchema, req => unpackWithTool(req, settings.get()));
  handle(CHANNELS.toolchainIdentify, unpackSchema, req => identifyWithTool(req, settings.get()));
  handle(CHANNELS.toolchainRoms, z.undefined().or(z.object({}).strict()), () => c64Roms(settings.get().vicePath));
  handle(CHANNELS.toolchainPack, packSchema, req => (req.prefs.packer === 'exomizer' ? packWithExomizer(req, settings.get(), policy) : packWithBrokkr(req, policy)));
  handle(CHANNELS.fileSave, fileSaveSchema, async (req, e): Promise<FileSaveResult | null> => {
    const win = windowOf(e.sender);
    const start = recent.folder('pack') ?? recent.folder('export');
    const ext = /\.(\w+)$/.exec(req.name)?.[1].toLowerCase() ?? 'prg';
    const options = { title: req.title ?? 'Save packed file', defaultPath: start ? join(start, req.name) : req.name, filters: [{ name: SAVE_KINDS[ext] ?? 'C64 file', extensions: [ext] }, { name: 'All files', extensions: ['*'] }] };
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (r.canceled || !r.filePath) return null;
    chose(dirname(r.filePath), 'pack');
    await writeFile(r.filePath, req.bytes);
    return { path: r.filePath };
  });
  handle(CHANNELS.terminalOpen, terminalOpenSchema, req => openTerminal(req.dir ? policy.assert(req.dir, 'Folder') : lastChosen ?? homedir(), settings.get()));
  handle(CHANNELS.viceAttach, viceAttachSchema, req => viceAttach(req));
  handle(CHANNELS.viceCommand, viceCommandSchema, req => viceCommand(req));
  // the file comes from the settings (or VICE's own folder), never from the renderer
  handle(CHANNELS.viceQuicksave, quicksaveSchema, req => readQuicksave(quicksaveFiles(settings.get().viceQuicksave), req));
  handle(CHANNELS.viceQuicksaveInfo, z.undefined().or(z.object({}).strict()), () => quicksaveInfo(quicksaveFiles(settings.get().viceQuicksave)));
  // the kept quicksaves (13.7b): by the ids of the list; their files are the app's own
  handle(CHANNELS.viceQuicksaves, z.undefined().or(z.object({}).strict()), async () => { await kept; return history.list(); });
  handle(CHANNELS.viceQuicksaveOpen, quicksaveEntrySchema, async req => {
    const { entry, bytes } = await history.get(req.id);
    return { found: true, path: history.file(req.id), saved: entry.saved, files: [openedPrg(openC64File(quicksaveFileName(entry.name), bytes, { zeroPage: req.zeroPage }))] };
  });
  handle(CHANNELS.viceQuicksaveRename, quicksaveRenameSchema, req => history.rename(req.id, req.name));
  handle(CHANNELS.viceQuicksaveFavourite, quicksaveFavouriteSchema, req => history.favourite(req.id, req.on));
  handle(CHANNELS.viceQuicksaveSave, quicksaveSaveSchema, async (req, e): Promise<FileSaveResult | null> => {
    const { entry, bytes } = await history.get(req.id);
    const win = windowOf(e.sender), start = recent.folder('snapshot'), file = quicksaveFileName(entry.name);
    const options = { title: `Save the quicksave "${entry.name}"`, defaultPath: start ? join(start, file) : file, filters: [{ name: 'VICE snapshot', extensions: ['vsf'] }, { name: 'All files', extensions: ['*'] }] };
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (r.canceled || !r.filePath) return null;
    chose(dirname(r.filePath), 'snapshot');
    await writeFile(r.filePath, bytes);
    return { path: r.filePath };
  });
  // the ROM comes from the VICE in the settings, never from a path the renderer gives
  handle(CHANNELS.viceCharRom, z.undefined().or(z.object({}).strict()), () => readCharRom(charRomFiles(settings.get().vicePath)));
  handle(CHANNELS.settingsGet, z.undefined().or(z.object({}).strict()), () => settings.get());
  handle(CHANNELS.settingsSet, toolchainSettingsSchema.partial(), req => {
    const next = settings.set(req);
    quicksave.watch(quicksaveFiles(next.viceQuicksave));
    kept = keepCurrent();
    return next;
  });
}
