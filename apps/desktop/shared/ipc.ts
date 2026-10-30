/* =====================================================================
 * IPC contract (spec 13.4). This is the exhaustive allowlist: the main
 * process registers exactly these channels and the preload exposes
 * exactly these functions as `window.kr`.
 * ===================================================================== */
import type { ExomizerReport, KickProblem, LoadedFile, PackCheck, PackPrefs, Project, ToolchainSettings } from '@mimir/core';

export const CHANNELS = {
  projectOpen: 'project:open',
  projectSave: 'project:save',
  prgOpen: 'prg:open',
  diskOpen: 'disk:open',
  exportWrite: 'export:write',
  toolchainBuild: 'toolchain:build',
  toolchainRun: 'toolchain:run',
  terminalOpen: 'terminal:open',
  toolchainUnpack: 'toolchain:unpack',
  toolchainIdentify: 'toolchain:identify',
  toolchainPack: 'toolchain:pack',
  fileSave: 'file:save',
  viceAttach: 'vice:attach',
  viceCommand: 'vice:command',
  viceQuicksave: 'vice:quicksave',
  viceQuicksaveInfo: 'vice:quicksave-info',
  viceQuicksaves: 'vice:quicksaves',
  viceQuicksaveOpen: 'vice:quicksave-open',
  viceQuicksaveRename: 'vice:quicksave-rename',
  viceQuicksaveSave: 'vice:quicksave-save',
  viceQuicksaveFavourite: 'vice:quicksave-favourite',
  viceCharRom: 'vice:chargen',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  /** main -> renderer */
  fsChanged: 'fs:changed',
  viceQuicksaved: 'vice:quicksaved',
} as const;

export type InvokeChannel = Exclude<(typeof CHANNELS)[keyof typeof CHANNELS], 'fs:changed' | 'vice:quicksaved'>;

/** `path` given: open it; otherwise the main process shows a file dialog. */
export interface ProjectOpenRequest { path?: string }
export interface ProjectOpenResult { path: string; project: Project }

/** `path` omitted (or not previously used in this session): the main process shows a save dialog. */
export interface ProjectSaveRequest { project: Project; path?: string }
export interface ProjectSaveResult { path: string }

/** `paths` given: read them (they must lie in folders the user picked); otherwise a file dialog. */
/** `zeroPage`: VICE snapshots open from $0002 (zero page and stack included) instead of $0200 */
export interface PrgOpenRequest { paths?: string[]; zeroPage?: boolean }
/** an opened PRG; a VICE snapshot also gives the entry points it holds, its program start and what it is */
export type OpenedPrg = LoadedFile & { entries?: number[]; snapshot?: string; start?: number };

/** A .d64 disk image to mount. `path` given: read it (in a folder the user picked); otherwise a file dialog. */
export interface DiskOpenRequest { path?: string }
export interface DiskOpenResult { path: string; name: string; bytes: Uint8Array }

/**
 * Where to write: `dir` (a folder the user picked earlier in this session), `target: 'pick'` (ask
 * with a folder dialog) or `target: 'temp'` (a fresh build folder under the OS temp dir).
 * File keys are relative paths; absolute paths and `..` are rejected.
 */
export interface ExportWriteRequest {
  dir?: string;
  target?: 'pick' | 'temp';
  /** used to name the folder for `target: 'temp'` */
  name?: string;
  files: Record<string, string | Uint8Array>;
}
export interface ExportWriteResult { dir: string; written: string[] }

/** Assemble each entry (an .asm file in `dir`) with KickAss.jar from the settings. */
export interface BuildRequest { dir: string; entries: string[] }
export interface BuildOutput {
  entry: string;
  ok: boolean;
  prg: Uint8Array | null;
  prgPath: string;
  vsPath: string | null;
  problems: KickProblem[];
}
export interface BuildResult {
  ok: boolean;
  /** console output of all runs */
  stdout: string;
  problems: KickProblem[];
  /** output of the first entry (spec 13.4) */
  prg?: Uint8Array;
  outputs: BuildOutput[];
  /** the exact argv of every run */
  commands: string[][];
  ms: number;
}

/** Start x64sc with the PRG (and VICE labels) from a build. */
/**
 * `start`: run with `sys <start>` after loading instead of autostarting (the program start set by the user).
 * `disk`: a .d64 image (a copy of the mounted disk in a build folder) to put in drive 8.
 */
export interface RunRequest { prgPath: string; labelsPath?: string; start?: number; disk?: string }
/** `via`: RUN, `sys <start>`, or (a program over BASIC's work area $0002-$03ff) loaded and started from the monitor */
export interface RunResult { pid: number; via: 'run' | 'sys' | 'monitor' }

/**
 * A terminal window (VICE on PATH, `kickass` defined) in `dir`: a folder opened in this session (the export or
 * project folder). Without one it opens where the last dialog picked something, or in the home folder.
 */
export interface TerminalOpenRequest { dir?: string }
export interface TerminalOpenResult { dir: string }

/**
 * Unpack a packed PRG (load address first) with the external unpacker of the toolchain settings (unp64). It runs
 * on a copy in a build folder of its own; `prg` is the file it wrote, `entry` the start address it reported.
 */
export interface UnpackRequest { name: string; prg: Uint8Array }
export interface UnpackResponse {
  ok: boolean; output: string; argv: string[]; dir: string; ms: number;
  name?: string; prg?: Uint8Array; entry?: number | null; packer?: string | null; error?: string;
}
/** Which packer a PRG uses, from unp64 -i (`supported` false when the unpacker is not unp64 or not set). */
export interface IdentifyResponse { supported: boolean; known: boolean; packer: string | null; tool: string }

/**
 * Pack with Exomizer (spec 13.8): the built PRGs (load address first, one per project file in order) are copied to a
 * pack folder of its own, where Exomizer packs them, or the ranges `prefs` chooses, as `prefs` says.
 */
export interface PackRequest { files: { name: string; prg: Uint8Array }[]; prefs: PackPrefs }
export interface PackResponse {
  ok: boolean; output: string; argv: string[]; ms: number;
  /** the pack folder (open in this session: the packed file can be run in VICE) */
  dir: string;
  /** the packed file: its name, path and bytes */
  name?: string; path?: string; prg?: Uint8Array;
  /** the memory that was packed */
  packed: { start: number; length: number } | null;
  report: ExomizerReport;
  /** sfx: Exomizer's desfx decrunched it, and this is how that compares with what was packed */
  check: (PackCheck & { argv: string[]; output: string }) | null;
  error?: string;
}

/** Save a file with a save dialog (the packed PRG); null: the dialog was cancelled. */
export interface FileSaveRequest { name: string; bytes: Uint8Array; title?: string }
export interface FileSaveResult { path: string }

/** VICE binary monitor (milestone M3); the channels exist so the contract is complete. */
export interface ViceAttachRequest { host?: string; port?: number }
export interface ViceCommandRequest { command: string }
export type ViceResult = { ok: true; response: string } | { ok: false; error: string };

export interface FsChangedEvent { path: string }

/** VICE's quicksave snapshot (13.7b), opened like a snapshot from Open PRG (`zeroPage`: from $0002) */
export interface QuicksaveRequest { zeroPage?: boolean }
/** the newest quicksave, or where VICE writes it when there is none yet; `saved`: its modification time */
export type QuicksaveResult = { found: false; path: string } | { found: true; path: string; saved: number; files: OpenedPrg[] };
/** whether there is a quicksave and when it was saved (it is not read); `path`: the newest, else where VICE writes it */
export interface QuicksaveInfo { found: boolean; path: string; saved?: number }
/** VICE's character ROM (4 KB, upper case then lower case), read from the VICE in the settings; `path`: where it is,
 *  or where it was looked for */
export type CharRomResult = { found: false; path: string } | { found: true; path: string; bytes: Uint8Array };
/** main -> renderer: VICE wrote a new quicksave (it is in the list of the newest already) */
export interface QuicksaveEvent { path: string; saved: number }
/** one of the quicksaves the app keeps (13.7b): a name the user can change, when VICE saved it, its size; `favourite`:
 *  it stays when VICE saves newer ones */
export interface QuicksaveEntry { id: string; name: string; saved: number; size: number; favourite?: boolean }
/** the kept quicksave `id`, opened like a snapshot from Open PRG */
export interface QuicksaveEntryRequest { id: string; zeroPage?: boolean }
export interface QuicksaveRenameRequest { id: string; name: string }
/** the kept quicksave `id` made a favourite (`on`), or one no more */
export interface QuicksaveFavouriteRequest { id: string; on: boolean }

export interface KrApi {
  openProject(req?: ProjectOpenRequest): Promise<ProjectOpenResult | null>;
  saveProject(req: ProjectSaveRequest): Promise<ProjectSaveResult | null>;
  openPrg(req?: PrgOpenRequest): Promise<OpenedPrg[]>;
  /** null: the dialog was cancelled */
  openDisk(req?: DiskOpenRequest): Promise<DiskOpenResult | null>;
  writeExport(req: ExportWriteRequest): Promise<ExportWriteResult | null>;
  build(req: BuildRequest): Promise<BuildResult>;
  run(req: RunRequest): Promise<RunResult>;
  openTerminal(req?: TerminalOpenRequest): Promise<TerminalOpenResult>;
  unpack(req: UnpackRequest): Promise<UnpackResponse>;
  identifyPacker(req: UnpackRequest): Promise<IdentifyResponse>;
  pack(req: PackRequest): Promise<PackResponse>;
  saveFile(req: FileSaveRequest): Promise<FileSaveResult | null>;
  viceAttach(req?: ViceAttachRequest): Promise<ViceResult>;
  viceCommand(req: ViceCommandRequest): Promise<ViceResult>;
  getSettings(): Promise<ToolchainSettings>;
  setSettings(patch: Partial<ToolchainSettings>): Promise<ToolchainSettings>;
  openQuicksave(req?: QuicksaveRequest): Promise<QuicksaveResult>;
  quicksaveInfo(): Promise<QuicksaveInfo>;
  /** the quicksaves the app keeps (the newest, and the favourites), the newest first */
  quicksaves(): Promise<QuicksaveEntry[]>;
  openQuicksaveEntry(req: QuicksaveEntryRequest): Promise<QuicksaveResult>;
  renameQuicksave(req: QuicksaveRenameRequest): Promise<QuicksaveEntry[]>;
  /** a save dialog: a copy of the kept quicksave in a folder of the user's; null: cancelled */
  saveQuicksave(req: { id: string }): Promise<FileSaveResult | null>;
  favouriteQuicksave(req: QuicksaveFavouriteRequest): Promise<QuicksaveEntry[]>;
  /** VICE's character ROM, for drawing screens in the Graphics tab */
  charRom(): Promise<CharRomResult>;
  /** Subscribe to new VICE quicksaves; returns an unsubscribe function. */
  onQuicksave(cb: (e: QuicksaveEvent) => void): () => void;
  /** Subscribe to file-watcher events for exported project folders; returns an unsubscribe function. */
  onFsChanged(cb: (e: FsChangedEvent) => void): () => void;
}
