/* Node-only: runs Kick Assembler and VICE. Executables are always started with
 * an argument array and `shell: false`, never through a shell string. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { KickProblem, Vfs } from '../types';
import { overwritesSystemArea } from '../c64/prg';
import { parseKickOutput } from '../verify/kick-output';
import { splitArgs } from '../util/args';

export { splitArgs };

/** Resolve `rel` inside `dir`, rejecting absolute paths and anything that escapes `dir`. */
export function safeJoin(dir: string, rel: string): string {
  if (!rel || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new Error(`refusing absolute path "${rel}"`);
  const root = resolve(dir);
  const full = resolve(root, normalize(rel));
  const r = relative(root, full);
  if (!r || r.startsWith('..') || isAbsolute(r)) throw new Error(`refusing path outside the target folder: "${rel}"`);
  return full;
}

/** Write a virtual file system (generated sources, binaries) below `dir`. Returns the relative paths written. */
export async function writeVfs(dir: string, files: Vfs): Promise<string[]> {
  const written: string[] = [];
  for (const [rel, data] of Object.entries(files)) {
    const full = safeJoin(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
    written.push(rel.split(sep).join('/'));
  }
  return written;
}

export interface KickRunOptions {
  java: string;
  jar: string;
  /** folder that contains the sources (the process' working directory) */
  cwd: string;
  /** source file, relative to cwd */
  entry: string;
  /** output folder, relative to cwd */
  outDir: string;
  /** extra arguments such as -vicesymbols -showmem */
  args?: string[];
  timeoutMs?: number;
}

export interface KickRunResult {
  ok: boolean;
  code: number | null;
  /** stdout and stderr interleaved as received */
  output: string;
  problems: KickProblem[];
  argv: string[];
  prgPath: string;
  prg: Uint8Array | null;
  /** VICE label file written by -vicesymbols, when present */
  vsPath: string | null;
  ms: number;
}

/** `java -jar KickAss.jar <entry> -odir <outDir> <args...>` in `cwd`. */
export async function runKickAssembler(o: KickRunOptions): Promise<KickRunResult> {
  const t0 = Date.now();
  const base = o.entry.replace(/\.asm$/i, '');
  const prgPath = join(o.cwd, o.outDir, base + '.prg');
  const vsPath = join(o.cwd, o.outDir, base + '.vs');
  await rm(prgPath, { force: true });
  await rm(vsPath, { force: true });
  const argv = ['-jar', o.jar, o.entry, '-odir', o.outDir, ...(o.args || [])];
  let output = '';
  const code = await new Promise<number | null>(done => {
    let child;
    try {
      child = spawn(o.java, argv, { cwd: o.cwd, shell: false, windowsHide: true });
    } catch (e) {
      output += `Error: could not start ${o.java}: ${(e as Error).message}\n`;
      done(null); return;
    }
    const timer = setTimeout(() => { output += `\nError: Kick Assembler did not finish within ${(o.timeoutMs ?? 60000) / 1000} s\n`; child.kill(); }, o.timeoutMs ?? 60000);
    child.stdout.on('data', d => { output += d.toString(); });
    child.stderr.on('data', d => { output += d.toString(); });
    child.on('error', e => { clearTimeout(timer); output += `Error: could not start "${o.java}": ${e.message}\n`; done(null); });
    child.on('close', c => { clearTimeout(timer); done(c); });
  });
  output = output.replace(/\r\n?/g, '\n');
  const problems = parseKickOutput(output, o.cwd);
  const prg = existsSync(prgPath) ? new Uint8Array(await readFile(prgPath)) : null;
  const ok = code === 0 && !problems.some(p => p.severity === 'error') && prg != null;
  return { ok, code, output, problems, argv: [o.java, ...argv], prgPath, prg, vsPath: existsSync(vsPath) ? vsPath : null, ms: Date.now() - t0 };
}

/** How VICE starts the program: RUN, `sys <start>` typed after loading, or a jump from the monitor. */
export type ViceStart = 'run' | 'sys' | 'monitor';

export interface ViceLaunch {
  vice: string; args?: string[]; prgPath: string; labelsPath?: string | null;
  /** start the program here instead of autostarting it (RUN) */
  start?: number | null;
  /** with a start: 'monitor' for a program that overwrites BASIC's work area (launchVice picks it from the PRG) */
  via?: Exclude<ViceStart, 'run'>;
  /** with via 'monitor': the monitor command file (viceMonitorScript) */
  scriptPath?: string;
  /** a .d64 image to put in drive 8, for programs that load more from disk */
  disk?: string | null;
}

/**
 * The x64sc command line: `<args...> [-moncommands labels.vs] -autostart program.prg`. With a start address the
 * program is loaded without RUN (`-autoload`) and `sys <start>` is typed into the keyboard buffer (VICE reads
 * `\n` there as RETURN, and lower case as unshifted letters). That needs the inject or disk image PRG mode: the
 * virtual file system mode loads through the keyboard buffer itself, so a `-autostartprgmode 0` is overridden.
 * A program that overwrites BASIC's work area leaves no BASIC to type into, so with via 'monitor' VICE stops at
 * the READY prompt (`-initbreak ready`) and runs the monitor commands of viceMonitorScript instead: load, then go.
 * A disk (`-8 disk.d64`) needs the inject PRG mode too: the disk image mode would put a disk of its own in drive 8.
 */
export function viceArgv(o: Omit<ViceLaunch, 'vice'>): string[] {
  const args = [...(o.args || [])];
  const drive = o.disk ? ['-8', o.disk] : [];
  if (o.start != null && o.via === 'monitor') {
    if (!o.scriptPath) throw new Error('starting from the monitor needs a monitor command file');
    return [...args, ...drive, '-moncommands', o.scriptPath, '-initbreak', 'ready'];
  }
  const i = args.lastIndexOf('-autostartprgmode'), mode = i >= 0 ? args[i + 1] : null;
  if (o.disk ? mode !== '1' : o.start != null && mode === '0') args.push('-autostartprgmode', '1');
  const run = o.start == null ? ['-autostart', o.prgPath] : ['-autoload', o.prgPath, '-keybuf', `sys${o.start & 0xffff}\\n`];
  return [...args, ...drive, ...(o.labelsPath ? ['-moncommands', o.labelsPath] : []), ...run];
}

/** Monitor commands that load the PRG at its own address (CPU view, as LOAD"…",8,1 does) and jump to start; labels first. */
export function viceMonitorScript(o: { prgPath: string; start: number; labels?: string }): string {
  const labels = o.labels ? o.labels.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n') : '';
  return `${labels}l "${o.prgPath}" 0\ng ${(o.start & 0xffff).toString(16).padStart(4, '0')}\n`;
}

/**
 * The command line for a launch (see viceArgv). With a start address, a PRG that overwrites BASIC's work area is
 * started from the monitor: its command file is written next to the PRG (`name.start.mon`).
 */
export async function prepareVice(o: Omit<ViceLaunch, 'vice'>): Promise<{ argv: string[]; via: ViceStart }> {
  if (o.start == null) return { argv: viceArgv(o), via: 'run' };
  const prg = await readFile(o.prgPath);
  if (!(prg.length > 2 && overwritesSystemArea(prg[0] | (prg[1] << 8), prg.length - 2))) return { argv: viceArgv({ ...o, via: 'sys' }), via: 'sys' };
  const scriptPath = o.prgPath.replace(/(\.prg)?$/i, '.start.mon');
  const labels = o.labelsPath && existsSync(o.labelsPath) ? await readFile(o.labelsPath, 'utf8') : '';
  await writeFile(scriptPath, viceMonitorScript({ prgPath: o.prgPath, start: o.start, labels }));
  return { argv: viceArgv({ ...o, via: 'monitor', scriptPath }), via: 'monitor' };
}

/** Start x64sc detached (see prepareVice). Returns the pid and how the program starts. */
export async function launchVice(o: ViceLaunch): Promise<{ pid: number; via: ViceStart }> {
  const { argv, via } = await prepareVice(o);
  const pid = await new Promise<number>((ok, fail) => {
    const child = spawn(o.vice, argv, { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', e => fail(new Error(`could not start "${o.vice}": ${e.message}`)));
    child.once('spawn', () => { child.unref(); ok(child.pid ?? -1); });
  });
  return { pid, via };
}
