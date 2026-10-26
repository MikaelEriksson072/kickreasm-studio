/* VICE's C64 character ROM (spec 14.5): the Graphics tab draws screens with it. It is read from the user's own VICE,
 * next to the x64sc in the settings, and never shipped with the app. */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CharRomResult } from '../../shared/ipc';

/** VICE 3.x names the ROM after its part number; older versions call it `chargen` */
export const CHARGEN_NAMES = ['chargen-901225-01.bin', 'chargen'];
/** the ROM is 4 KB: upper case and graphics, then lower case */
export const CHARGEN_SIZE = 0x1000;

/** where the ROM can be: VICE's C64 folder beside its bin folder (the Windows builds), or beside the program */
export function charRomFiles(vicePath: string): string[] {
  if (!vicePath.trim()) return [];
  const bin = dirname(vicePath.trim());
  return [join(bin, '..', 'C64'), join(bin, 'C64')].flatMap(d => CHARGEN_NAMES.map(n => join(d, n)));
}

/** the first of `files` that is a 4 KB ROM; `path` says where it was looked for when there is none */
export async function readCharRom(files: string[]): Promise<CharRomResult> {
  for (const f of files) {
    try {
      const b = await readFile(f);
      if (b.length === CHARGEN_SIZE) return { found: true, path: f, bytes: new Uint8Array(b) };
    } catch { /* not there */ }
  }
  return { found: false, path: files[0] ?? '' };
}
