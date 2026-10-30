/* Node-only: finding and reading the C64 ROM files (BASIC, KERNAL, character ROM) and the 1541's DOS ROM. The
 * unpacker never ships them; it takes them from a folder you name, or from a VICE installation it finds (the DOS ROM
 * from the same folder or VICE's DRIVES folder next to it). */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Roms } from './c64.ts';

const PATTERNS = {
  kernal: { re: /^kernal/i, size: 0x2000, prefer: /901227-03/ },
  basic: { re: /^basic/i, size: 0x2000, prefer: /901226-01/ },
  chargen: { re: /^chargen/i, size: 0x1000, prefer: /901225-01/ },
  drive: { re: /^dos1541(?!ii)/i, size: 0x4000, prefer: /325302-01\+901229-05/ },
};

const files = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** The ROM files in `dir` (as VICE names them, e.g. kernal-901227-03.bin), or null when one is missing. */
export function loadRoms(dir: string): Roms | null {
  const pick = (k: keyof typeof PATTERNS, from = dir): Uint8Array | null => {
    const { re, size, prefer } = PATTERNS[k];
    const found = files(from).filter(n => re.test(n) && !/\.(vpl|sym|vkm)$/i.test(n))
      .filter(n => { try { return statSync(join(from, n)).size === size; } catch { return false; } })
      .sort((a, b) => Number(prefer.test(b)) - Number(prefer.test(a)) || a.localeCompare(b));
    return found.length ? new Uint8Array(readFileSync(join(from, found[0]))) : null;
  };
  const kernal = pick('kernal'), basic = pick('basic'), chargen = pick('chargen');
  if (!kernal || !basic || !chargen) return null;
  const roms: Roms = { kernal, basic, chargen, source: dir };
  for (const at of [dir, join(dir, '..', 'DRIVES'), join(dir, '..', 'drives')]) {
    const drive = pick('drive', at);
    if (drive) { roms.drive = drive; roms.driveSource = at; break; }
  }
  return roms;
}

/** Folders that may hold a VICE installation's C64 ROMs, most likely first. */
export function romFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.C64_ROMS) out.push(env.C64_ROMS);
  const bases = process.platform === 'win32'
    ? ['C:\\C64', env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'), 'C:\\']
    : ['/usr/share/vice', '/usr/lib/vice', '/usr/local/share/vice', '/usr/local/lib/vice', '/opt/homebrew/share/vice',
      join(homedir(), '.local/share/vice'), '/Applications'];
  for (const base of bases) {
    if (!base || !isDir(base)) continue;
    out.push(join(base, 'C64'), join(base, 'data', 'C64'));
    for (const a of files(base).filter(n => /vice/i.test(n)).map(n => join(base, n))) {
      out.push(join(a, 'C64'), join(a, 'data', 'C64'), join(a, 'share', 'vice', 'C64'));
      for (const b of files(a).filter(n => /vice/i.test(n)).map(n => join(a, n))) out.push(join(b, 'C64'), join(b, 'data', 'C64'));
    }
  }
  return [...new Set(out)];
}

/** The ROMs of the first folder that has all three, or null. */
export function findRoms(env: NodeJS.ProcessEnv = process.env): Roms | null {
  for (const dir of romFolders(env)) {
    if (!existsSync(dir)) continue;
    const roms = loadRoms(dir);
    if (roms) return roms;
  }
  return null;
}
