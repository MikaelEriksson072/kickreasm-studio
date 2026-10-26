/* Node-only: runs an external unpacker (unp64, or exomizer's desfx) on a copy of a packed PRG in a folder of its
 * own and picks up what it wrote. The tool is started with an argument array, never through a shell. */
import { spawn } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { splitArgs } from './toolchain';

export interface UnpackOptions {
  exe: string;
  /** argument template: `{in}` is the packed PRG, `{out}` a file name for the result (default `{in}`) */
  args?: string;
  /** an empty folder to work in */
  dir: string;
  /** the packed file's name (made safe for the file system) and bytes (load address first) */
  name: string; prg: Uint8Array;
  timeoutMs?: number;
}

export interface UnpackResult {
  ok: boolean;
  code: number | null;
  output: string;
  argv: string[];
  /** the unpacked PRG (load address first) */
  file: { name: string; prg: Uint8Array } | null;
  /** where the unpacked program starts, from the file name (unp64 writes `name.xxxx`) or the tool's output */
  entry: number | null;
  /** the packer the tool identified */
  packer: string | null;
  error?: string;
  ms: number;
}

export interface IdentifyResult { known: boolean; packer: string | null; output: string; argv: string[] }

/** A safe file name for the packed copy: letters, digits, `._-` and spaces; always `.prg`. */
export const unpackInputName = (name: string): string => `${(name.replace(/\.prg$/i, '').replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[. ]+|[. ]+$/g, '') || 'packed')}.prg`;
export const UNPACK_OUT = 'unpacked.prg';

/** The tool's arguments: `{in}`/`{out}` replaced; a template without `{in}` gets the input file last. */
export function unpackArgs(template: string | undefined, inName: string, outName = UNPACK_OUT): string[] {
  const args = splitArgs(template?.trim() ? template : '{in}');
  const filled = args.map(a => a.split('{in}').join(inName).split('{out}').join(outName));
  return args.some(a => a.includes('{in}')) ? filled : [...filled, inName];
}

/**
 * The start address of the unpacked program: the `.xxxx` hex suffix unp64 puts on its file (the last one after
 * several passes), else unp64's "return to mem: $xxxx", else "jmp/start/sys $xxxx" in the output, else "entry $xxxx".
 * (unp64's own "Entry point:" is where the packed file starts, so it only counts for other tools.)
 */
export function unpackEntry(fileName: string, output: string): number | null {
  const m = /\.([0-9a-f]{4})(?:\.prg)?$/i.exec(fileName);
  if (m) return parseInt(m[1], 16);
  for (const re of [/return to mem:\s*\$([0-9a-f]{4})\b/i, /\b(?:jmp|jump(?:s)? to|start(?:s|ing)?(?: address| at)?|sys)\s*[:=]?\s*\$([0-9a-f]{4})\b/i, /\bentry(?: point)?\s*[:=]?\s*\$([0-9a-f]{4})\b/i]) {
    const t = re.exec(output);
    if (t) return parseInt(t[1], 16);
  }
  return null;
}

/** The packer the tool names: unp64 prints "<packer>, unpacker=$xxxx" (after "file : " with -i). */
export function unpackPacker(output: string): string | null {
  const m = /^\s*(?:.* : )?(.+?), unpacker=\$[0-9a-f]{4}/im.exec(output);
  return m && m[1].trim() && !/\(unknown\)/i.test(m[1]) ? m[1].trim() : null;
}

/** unp64 (by its file name) can name the packer without unpacking: `unp64 file -i`. */
export const canIdentify = (exe: string): boolean => /^unp64(\.exe)?$/i.test(exe.split(/[\\/]/).pop() ?? '');

/** Of the files in the folder after the run: `{out}` when the tool wrote it, else the largest new or changed file. */
export function pickUnpacked(after: { name: string; size: number; mtimeMs: number }[], before: Map<string, number>, inName: string, outName = UNPACK_OUT): string | null {
  const fresh = after.filter(f => f.name !== inName && f.size > 2 && before.get(f.name) !== f.mtimeMs);
  const out = fresh.find(f => f.name === outName);
  if (out) return out.name;
  return fresh.sort((a, b) => b.size - a.size || b.mtimeMs - a.mtimeMs)[0]?.name ?? null;
}

const listing = async (dir: string) => Promise.all((await readdir(dir, { withFileTypes: true })).filter(d => d.isFile()).map(async d => {
  const s = await stat(join(dir, d.name));
  return { name: d.name, size: s.size, mtimeMs: s.mtimeMs };
}));

/** Run the tool in `dir` (argument array, no shell); stdout and stderr together, with a time limit. */
export function runTool(exe: string, args: string[], dir: string, timeoutMs = 60000): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    let output = '';
    const done = (code: number | null) => resolve({ code, output: output.replace(/\r\n?/g, '\n') });
    let child;
    try {
      child = spawn(exe, args, { cwd: dir, shell: false, windowsHide: true });
    } catch (e) { output += (e as Error).message; done(null); return; }
    const timer = setTimeout(() => { output += `\n(stopped after ${Math.round(timeoutMs / 1000)} s)`; child.kill(); }, timeoutMs);
    child.stdout?.on('data', d => { output += d.toString('latin1'); });
    child.stderr?.on('data', d => { output += d.toString('latin1'); });
    child.on('error', e => { clearTimeout(timer); output += `could not start "${exe}": ${e.message}`; done(null); });
    child.on('close', c => { clearTimeout(timer); done(c); });
  });
}

export async function runUnpacker(o: UnpackOptions): Promise<UnpackResult> {
  const t0 = Date.now();
  const inName = unpackInputName(o.name);
  await writeFile(join(o.dir, inName), o.prg);
  const before = new Map((await listing(o.dir)).map(f => [f.name, f.mtimeMs]));
  const args = unpackArgs(o.args, inName);
  const argv = [o.exe, ...args];
  const { code, output } = await runTool(o.exe, args, o.dir, o.timeoutMs);
  const packer = unpackPacker(output);
  const picked = pickUnpacked(await listing(o.dir), before, inName);
  const ms = Date.now() - t0;
  if (!picked) return { ok: false, code, output, argv, file: null, entry: null, packer, error: code == null ? 'the unpacker did not run' : 'the unpacker wrote no file', ms };
  const prg = new Uint8Array(await readFile(join(o.dir, picked)));
  if (prg.length < 3) return { ok: false, code, output, argv, file: null, entry: null, packer, error: `${picked} is too short to be a PRG`, ms };
  return { ok: true, code, output, argv, file: { name: picked, prg }, entry: unpackEntry(picked, output), packer, ms };
}

/** Ask unp64 which packer a file uses (`unp64 file -i`, which unpacks nothing); exit code 1 means it knows it. */
export async function identifyPacker(o: Omit<UnpackOptions, 'args'>): Promise<IdentifyResult> {
  const inName = unpackInputName(o.name);
  await writeFile(join(o.dir, inName), o.prg);
  const args = [inName, '-i'];
  const { code, output } = await runTool(o.exe, args, o.dir, o.timeoutMs ?? 20000);
  const packer = unpackPacker(output);
  return { known: code === 1 && packer != null, packer, output, argv: [o.exe, ...args] };
}
