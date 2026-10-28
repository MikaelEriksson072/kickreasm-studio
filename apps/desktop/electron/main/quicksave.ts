/* VICE's quicksave snapshot (spec 13.7b): Snapshot → Quicksave snapshot (Alt+F11 in VICE 3.x) writes <machine>.vsf in
 * VICE's settings folder, C64SC.vsf for x64sc and C64.vsf for x64. The app reads the newest of them (or the file set in
 * Settings → Toolchain), and watches them: each new quicksave is announced to the renderer, which opens it. */
import { unwatchFile, watchFile, type Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isVsf, openC64File } from '@mimir/core';
import type { QuicksaveEvent, QuicksaveInfo, QuicksaveResult } from '../../shared/ipc';
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
