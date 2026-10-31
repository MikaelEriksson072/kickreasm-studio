/* Project files (.mimir.json), PRG input (VICE snapshots too), exported project folders and their file watcher. */
import { watch, type FSWatcher } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { deserializeProject, isCrt, openC64File, openCartridge, parseD64, serializeProject, withId, type OpenedFile, type OpenOptions, type Project, type SerializedProject, type Settings } from '@mimir/core';
import type { OpenedPrg } from '../../shared/ipc';
import { writeVfs } from '@mimir/core/node';
import { serializedProjectSchema } from './schemas';

export async function readProjectFile(path: string): Promise<Project> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new Error(`${basename(path)} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = serializedProjectSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${basename(path)} is not a Mimir project: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  return deserializeProject(parsed.data as SerializedProject);
}

/** A project as validated from the renderer: settings may be partial (defaults fill them in on load). */
export type SaveableProject = Omit<Project, 'settings'> & { settings: Partial<Settings> };

export async function writeProjectFile(path: string, project: SaveableProject): Promise<void> {
  await writeFile(path, JSON.stringify(serializeProject(project as Project), null, 1));
}

/** PRG files, VICE snapshots (.vsf) as their RAM from $0200 (`zeroPage`: from $0002) with the entry points they give,
 *  and cartridge images (.crt, known by their header) as the chips of their boot bank, each with the image */
export async function readPrgFiles(paths: string[], opts: OpenOptions = {}): Promise<OpenedPrg[]> {
  const out: OpenedPrg[] = [];
  for (const p of paths) {
    const bytes = new Uint8Array(await readFile(p));
    if (isCrt(bytes)) { const o = openCartridge(basename(p), bytes); out.push(...o.files.map(f => ({ ...withId(f), cart: o.cart }))); continue; }
    out.push(openedPrg(openC64File(basename(p), bytes, opts)));
  }
  return out;
}

/** an opened PRG or snapshot as the renderer gets it: an id, and a snapshot's entry points, program start and description */
export const openedPrg = (f: OpenedFile): OpenedPrg =>
  ({ ...withId(f), ...(f.entries ? { entries: f.entries } : {}), ...(f.snapshot ? { snapshot: f.snapshot } : {}), ...(f.start != null ? { start: f.start } : {}) });

/** A .d64 disk image (the renderer reads its directory and files); anything that is not one is refused here. */
export async function readDiskImage(path: string): Promise<{ path: string; name: string; bytes: Uint8Array }> {
  const st = await stat(path);
  if (!st.isFile() || st.size > 206114) throw new Error(`${basename(path)} is not a .d64 disk image (${st.size} bytes)`);
  const bytes = new Uint8Array(await readFile(path));
  parseD64(bytes);
  return { path, name: basename(path), bytes };
}

export async function createBuildFolder(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `mimir-${name || 'build'}-`));
}

export const writeExportFolder = (dir: string, files: Record<string, string | Uint8Array>) => writeVfs(dir, files);

/**
 * Watches exported folders and reports external edits (e.g. the user editing the .asm in another
 * editor). Changes caused by our own writes are suppressed for a moment.
 */
export class ExportWatcher {
  private watchers = new Map<string, FSWatcher>();
  private quietUntil = new Map<string, number>();
  constructor(private readonly onChange: (path: string) => void) {}

  touched(dir: string) { this.quietUntil.set(dir, Date.now() + 1500); }

  /** a file the app writes into a folder that may be watched (the packed file): no change reported for it */
  wrote(path: string) {
    for (const dir of this.watchers.keys()) {
      const rel = relative(dir, path);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) this.touched(dir);
    }
  }

  watch(dir: string) {
    if (this.watchers.has(dir)) return;
    try {
      const w = watch(dir, { recursive: true }, (_event, file) => {
        if (Date.now() < (this.quietUntil.get(dir) ?? 0) || !file) return;
        this.onChange(join(dir, file.toString()));
      });
      w.on('error', () => this.unwatch(dir));
      this.watchers.set(dir, w);
    } catch {
      // watching is best effort (network drives, missing recursive support)
    }
  }

  unwatch(dir: string) { this.watchers.get(dir)?.close(); this.watchers.delete(dir); }
  close() { for (const d of [...this.watchers.keys()]) this.unwatch(d); }
}
