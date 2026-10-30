/* VICE's quicksave snapshot (spec 13.7b): Snapshot → Quicksave snapshot (Alt+F11 in VICE 3.x) writes <machine>.vsf in
 * VICE's settings folder, C64SC.vsf for x64sc and C64.vsf for x64. The app reads the newest of them (or the file set in
 * Settings → Toolchain), and watches them: each new quicksave is announced to the renderer, which opens it. */
import { existsSync, unwatchFile, watchFile, type Stats } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { isVsf, openC64File, parseVsf } from '@mimir/core';
import type { QuicksaveEntry, QuicksaveEvent, QuicksaveInfo, QuicksaveResult } from '../../shared/ipc';
import { openedPrg } from './project-fs';

/** the machines whose quicksave the app reads: x64sc, then x64 */
export const QUICKSAVE_NAMES = ['C64SC.vsf', 'C64.vsf'];
/** the name the opened snapshot gets (its file becomes quicksave.prg) */
export const QUICKSAVE_FILE = 'quicksave.vsf';

/** VICE's settings folder: %APPDATA%\vice on Windows, $XDG_CONFIG_HOME/vice (~/.config/vice) elsewhere */
export function viceConfigDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  return platform === 'win32' ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'vice') : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'vice');
}

/** The files a quicksave can be: the one set in Settings, else C64SC.vsf and C64.vsf in VICE's settings folder. */
export const quicksaveFiles = (setting: string, dir = viceConfigDir()): string[] =>
  setting.trim() ? [setting.trim()] : QUICKSAVE_NAMES.map(n => join(dir, n));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** the existing files, the newest first */
async function existing(files: string[]): Promise<{ path: string; st: Stats }[]> {
  const found: { path: string; st: Stats }[] = [];
  for (const path of files) { try { const st = await stat(path); if (st.isFile() && st.size > 0) found.push({ path, st }); } catch { /* not there */ } }
  return found.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
}

/** Whether there is a quicksave, and when the newest was saved (the Explorer shows it); without one, where VICE writes it. */
export async function quicksaveInfo(files: string[]): Promise<QuicksaveInfo> {
  const [newest] = await existing(files);
  return newest ? { found: true, path: newest.path, saved: newest.st.mtimeMs } : { found: false, path: files[0] ?? '' };
}

/**
 * The newest of `files` as an opened snapshot (from $0200, or $0002 with `zeroPage`), or where VICE would write one.
 * A snapshot VICE is still writing does not parse yet: it is read again a moment later.
 */
export async function readQuicksave(files: string[], opts: { zeroPage?: boolean } = {}): Promise<QuicksaveResult> {
  const [newest] = await existing(files);
  if (!newest) return { found: false, path: files[0] ?? '' };
  const { path, st } = newest;
  for (let attempt = 0; ; attempt++) {
    const bytes = new Uint8Array(await readFile(path));
    if (!isVsf(bytes)) throw new Error(`${path} is not a VICE snapshot`);
    try {
      return { found: true, path, saved: st.mtimeMs, files: [openedPrg(openC64File(QUICKSAVE_FILE, bytes, opts))] };
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(300);
    }
  }
}

/** how many of VICE's quicksaves the app keeps */
export const KEPT_QUICKSAVES = 5;

const entryId = z.string().regex(/^[a-z0-9]{1,32}$/);
const indexSchema = z.array(z.object({ id: entryId, name: z.string().min(1).max(80), saved: z.number(), size: z.number().int().min(0), favourite: z.boolean().optional() })).max(256);

/** a quicksave's name as it starts: `quicksave 2026-10-29 12:43:30` (when VICE saved it, local time) */
export function quicksaveName(saved: number): string {
  const d = new Date(saved), p = (n: number) => String(n).padStart(2, '0');
  return `quicksave ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** a name as a file name: what Windows does not allow in one becomes `-` */
export const quicksaveFileName = (name: string): string => `${name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').replace(/[. ]+$/, '') || 'quicksave'}.vsf`; // eslint-disable-line no-control-regex

const gone = `That quicksave is no longer kept (only the newest ${KEPT_QUICKSAVES} and the favourites are)`;

/** a whole snapshot (VICE writes it in pieces: one that does not parse yet is not one) */
const whole = (bytes: Uint8Array) => { if (!isVsf(bytes)) return false; try { parseVsf(bytes); return true; } catch { return false; } };

/**
 * The newest quicksaves VICE wrote, kept in a folder of the app's (`<user data>/quicksaves`, with `index.json`): each new
 * one is copied there with a name the user can change, so the next Alt+F11 does not take it. The newest
 * KEPT_QUICKSAVES stay, and the favourites besides them until they are favourites no more; one saved to a folder of the
 * user's stays there. One thing at a time, in order.
 */
export class QuicksaveHistory {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly dir: string, private readonly keep = KEPT_QUICKSAVES) {}

  private run<T>(fn: () => Promise<T>): Promise<T> { const p = this.queue.then(fn, fn); this.queue = p.catch(() => undefined); return p; }
  /** where the kept quicksave is (an id from the list only) */
  file(id: string): string { return join(this.dir, `${entryId.parse(id)}.vsf`); }
  private async read(): Promise<QuicksaveEntry[]> {
    try {
      const list = indexSchema.parse(JSON.parse(await readFile(join(this.dir, 'index.json'), 'utf8')));
      return list.filter(e => existsSync(this.file(e.id)));
    } catch { return []; }
  }
  private async write(list: QuicksaveEntry[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, 'index.json'), JSON.stringify(list, null, 1));
  }

  /** the kept quicksaves, the favourites among them, the newest first */
  list(): Promise<QuicksaveEntry[]> { return this.run(() => this.read()); }

  /** Keep the quicksave VICE wrote at `path` at `saved` (once: the same save again is not a new one). Of the others the
   *  newest `keep` stay, and every favourite. */
  add(path: string, saved: number): Promise<QuicksaveEntry[]> {
    return this.run(async () => {
      const list = await this.read();
      if (list.some(e => e.saved === saved)) return list;
      let bytes: Uint8Array | null = null;
      for (let attempt = 0; attempt < 4 && !bytes; attempt++) {
        try { const b = new Uint8Array(await readFile(path)); if (whole(b)) bytes = b; } catch { /* not there now */ }
        if (!bytes) await sleep(300);
      }
      if (!bytes) return list;
      const id = `${Math.round(saved).toString(36)}${Math.random().toString(36).slice(2, 6)}`.toLowerCase().replace(/[^a-z0-9]/g, '');
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.file(id), bytes);
      const all: QuicksaveEntry[] = [{ id, name: quicksaveName(saved), saved, size: bytes.length }, ...list].sort((a, b) => b.saved - a.saved);
      const drop = new Set(all.filter(e => !e.favourite).slice(this.keep).map(e => e.id));
      for (const old of drop) await rm(this.file(old), { force: true });
      const next = all.filter(e => !drop.has(e.id));
      await this.write(next);
      return next;
    });
  }

  rename(id: string, name: string): Promise<QuicksaveEntry[]> {
    return this.run(async () => {
      const list = (await this.read()).map(e => (e.id === id ? { ...e, name: name.trim() || e.name } : e));
      await this.write(list);
      return list;
    });
  }

  /** Make the kept quicksave a favourite, which stays, or one no more: then it is one of the others again, and goes when
   *  VICE saves a new quicksave if it is not among the newest `keep` of them (not before). */
  favourite(id: string, on: boolean): Promise<QuicksaveEntry[]> {
    return this.run(async () => {
      const list = await this.read();
      if (!list.some(e => e.id === id)) throw new Error(gone);
      const next = list.map(e => (e.id !== id ? e : on ? { ...e, favourite: true } : { id: e.id, name: e.name, saved: e.saved, size: e.size }));
      await this.write(next);
      return next;
    });
  }

  /** the kept quicksave: its entry and bytes */
  get(id: string): Promise<{ entry: QuicksaveEntry; bytes: Uint8Array }> {
    return this.run(async () => {
      const entry = (await this.read()).find(e => e.id === id);
      if (!entry) throw new Error(gone);
      return { entry, bytes: new Uint8Array(await readFile(this.file(id))) };
    });
  }
}

/** Calls `onSaved` when one of the files gets a new quicksave (written, or created); polling, so a folder that
 *  does not exist yet works too. */
export class QuicksaveWatcher {
  private files: string[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly onSaved: (e: QuicksaveEvent) => void, private readonly interval = 750) {}

  watch(files: string[]): void {
    if (files.join('\n') === this.files.join('\n')) return;
    this.close();
    this.files = files;
    for (const path of files) {
      watchFile(path, { interval: this.interval }, (cur, prev) => {
        if (!cur.mtimeMs || cur.size === 0 || cur.mtimeMs === prev.mtimeMs) return;
        // VICE writes the file in pieces: report it once it has been quiet for a moment
        clearTimeout(this.timers.get(path));
        this.timers.set(path, setTimeout(() => { this.timers.delete(path); this.onSaved({ path, saved: cur.mtimeMs }); }, 250));
      });
    }
  }

  close(): void {
    for (const path of this.files) unwatchFile(path);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.files = [];
  }
}
