/* Best-effort discovery of a local Kick Assembler / VICE install for first-run defaults, and of VICE's C64 ROMs. */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Roms } from '@mimir/unpacker';
import { findRoms, loadRoms } from '@mimir/unpacker/node';

const firstExisting = (paths: string[]): string | null => paths.find(p => { try { return existsSync(p); } catch { return false; } }) ?? null;

/** Subfolders of `dir` (one level), or none. */
const subdirs = (dir: string): string[] => { try { return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(dir, d.name)); } catch { return []; } };

export function findKickAssJar(extra: string[] = []): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return firstExisting([
    ...extra,
    process.env.KICKASS_JAR || '',
    'C:\\C64\\KickAssembler\\KickAss.jar', 'C:\\C64\\KickAss\\KickAss.jar', 'C:\\KickAssembler\\KickAss.jar',
    join(home, 'c64', 'KickAss.jar'), join(home, 'c64', 'KickAssembler', 'KickAss.jar'),
    '/usr/local/share/kickassembler/KickAss.jar', '/opt/kickassembler/KickAss.jar',
  ].filter(Boolean));
}

export function findVice(extra: string[] = []): string | null {
  const exe = process.platform === 'win32' ? 'x64sc.exe' : 'x64sc';
  const roots = ['C:\\C64\\VICE', 'C:\\C64\\vice', 'C:\\Program Files\\VICE', process.env.VICE_HOME || ''].filter(Boolean);
  const candidates = [...extra, process.env.VICE || ''].filter(Boolean);
  for (const r of roots) {
    candidates.push(join(r, 'bin', exe), join(r, exe));
    for (const d of subdirs(r)) candidates.push(join(d, 'bin', exe), join(d, exe));
  }
  candidates.push('/usr/bin/x64sc', '/usr/local/bin/x64sc', '/opt/homebrew/bin/x64sc', '/Applications/vice-x86-64-gtk3/bin/x64sc');
  return firstExisting(candidates);
}

/** Where VICE keeps its C64 ROMs, from the x64sc in the settings: its C64 folder beside the bin folder (the Windows
 * builds), beside the program, or in share/vice. */
export function viceRomFolders(vicePath: string): string[] {
  if (!vicePath.trim()) return [];
  const bin = dirname(vicePath.trim());
  return [join(bin, '..', 'C64'), join(bin, 'C64'), join(bin, '..', 'share', 'vice', 'C64')];
}

/** The C64 ROMs (KERNAL, BASIC, character ROM) for the built-in unpacker: those of the VICE in the settings, else of a
 * VICE installation the unpacker finds (C64_ROMS, C:\C64, Program Files, the usual Linux and macOS places). Null: it
 * runs with its stand-ins. The ROMs are read from the user's own VICE and never shipped. */
export function findC64Roms(vicePath = ''): Roms | null {
  for (const dir of viceRomFolders(vicePath)) {
    const roms = loadRoms(dir);
    if (roms) return roms;
  }
  return findRoms();
}

/** unp64 (the generic C64 unpacker): UNP64 env var, the usual C:\C64 folders, then PATH. */
export function findUnp64(extra: string[] = []): string | null {
  const exe = process.platform === 'win32' ? 'unp64.exe' : 'unp64';
  const candidates = [...extra, process.env.UNP64 || ''].filter(Boolean);
  for (const r of ['C:\\C64', 'C:\\C64\\Tools', 'C:\\C64\\unp64']) {
    candidates.push(join(r, exe));
    for (const d of subdirs(r)) candidates.push(join(d, exe));
  }
  for (const d of (process.env.PATH || process.env.Path || '').split(process.platform === 'win32' ? ';' : ':')) if (d) candidates.push(join(d, exe));
  return firstExisting(candidates);
}

/** Exomizer 3: EXOMIZER env var, the usual C:\C64 folders (an unpacked release keeps it in win32\), then PATH. */
export function findExomizer(extra: string[] = []): string | null {
  const exe = process.platform === 'win32' ? 'exomizer.exe' : 'exomizer';
  const candidates = [...extra, process.env.EXOMIZER || ''].filter(Boolean);
  for (const r of ['C:\\C64', 'C:\\C64\\Tools', 'C:\\C64\\exomizer']) {
    candidates.push(join(r, exe), join(r, 'win32', exe));
    for (const d of subdirs(r)) candidates.push(join(d, exe), join(d, 'win32', exe), join(d, 'bin', exe));
  }
  for (const d of (process.env.PATH || process.env.Path || '').split(process.platform === 'win32' ? ';' : ':')) if (d) candidates.push(join(d, exe));
  return firstExisting(candidates);
}
