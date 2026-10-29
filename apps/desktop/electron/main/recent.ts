/* The folder each file dialog was last used in (PRG, disk image, project, export, packed file, saved snapshot), stored as JSON in
 * the user data folder so it survives a restart. A dialog opens there, or else where any dialog was last used. It only sets
 * where a dialog starts: access still comes from what the user picks (see PathPolicy). */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export type RecentKind = 'prg' | 'disk' | 'project' | 'export' | 'pack' | 'snapshot';

const KINDS = ['prg', 'disk', 'project', 'export', 'pack', 'snapshot'] as const satisfies readonly RecentKind[];
const folder = z.string().min(1).max(4096);
const fileSchema = z.object({ last: folder.optional(), ...Object.fromEntries(KINDS.map(k => [k, folder.optional()])) }).partial();

const isDir = (p: string | undefined): p is string => { try { return !!p && existsSync(p) && statSync(p).isDirectory(); } catch { return false; } };

export class RecentFolders {
  private readonly file: string;
  private value: Partial<Record<RecentKind | 'last', string>> = {};

  constructor(dir: string) {
    this.file = join(dir, 'recent-folders.json');
    try {
      if (existsSync(this.file)) this.value = fileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))) as typeof this.value;
    } catch {
      this.value = {}; // an unreadable file only means the dialogs start where Windows puts them
    }
  }

  /** where a dialog of this kind starts: its own last folder, else the last folder of any dialog (if it still exists) */
  folder(kind: RecentKind): string | undefined {
    return [this.value[kind], this.value.last].find(isDir);
  }

  remember(kind: RecentKind, dir: string): void {
    this.value = { ...this.value, [kind]: dir, last: dir };
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    } catch { /* remembering is best effort */ }
  }
}
