/* Node-only: packs built PRGs (or ranges of them) with Exomizer 3 in a folder of its own (spec 13.8), and checks a
 * self-extracting result with Exomizer's desfx, which runs the decruncher in Exomizer's own 6502 emulator and writes
 * what it decrunched. The tool is started with an argument array, never through a shell. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PackPrefs } from '../types';
import {
  checkDecrunched, packArgs, packFileName, packImage, packInputs, packOutName, packParts, packProblem, parseExomizer,
  type ExomizerReport, type PackCheck,
} from '../pack';
import { runTool } from './unpack';

export interface ExomizerOptions {
  exe: string;
  /** an empty folder to work in */
  dir: string;
  /** the built PRGs (load address first), in project order */
  files: { name: string; prg: Uint8Array }[];
  prefs: PackPrefs;
  /** check a self-extracting result with desfx (default: yes) */
  check?: boolean;
  timeoutMs?: number;
}

export interface ExomizerResult {
  ok: boolean;
  code: number | null;
  output: string;
  argv: string[];
  /** the packed file, written in `dir` */
  out: { name: string; prg: Uint8Array } | null;
  /** the memory that was packed (gaps between the parts zero-filled, as Exomizer does) */
  packed: { start: number; length: number } | null;
  report: ExomizerReport;
  /** sfx: what desfx decrunched, compared with what was packed */
  check: (PackCheck & { argv: string[]; output: string }) | null;
  error?: string;
  ms: number;
}

export const DESFX_OUT = 'desfx-check.prg';

export async function runExomizer(o: ExomizerOptions): Promise<ExomizerResult> {
  const t0 = Date.now();
  const empty = { code: null, output: '', argv: [], out: null, packed: null, report: parseExomizer(''), check: null };
  const fail = (error: string): ExomizerResult => ({ ok: false, ...empty, error, ms: Date.now() - t0 });
  const problem = packProblem(o.prefs);
  if (problem) return fail(problem);
  if (!o.files.length || o.files.some(f => f.prg.length < 3)) return fail('There is no built PRG to pack.');
  // the copies get names Exomizer reads as one file name, distinct from each other and from the files it writes
  const used = new Set<string>([DESFX_OUT]);
  const files = o.files.map((f, i) => {
    let name = packFileName(f.name);
    if (used.has(name.toLowerCase())) name = packFileName(`${f.name.replace(/\.prg$/i, '')}-${i + 1}`);
    used.add(name.toLowerCase());
    return { name, load: f.prg[0] | (f.prg[1] << 8), bytes: f.prg.subarray(2), prg: f.prg };
  });
  const outName = packOutName(o.prefs, files[0].name);
  if (used.has(outName.toLowerCase())) return fail(`The packed file cannot be called ${outName}: that is the name of a file it packs.`);
  const parts = packParts(o.prefs.ranges, files);
  if (!parts.length) return fail('None of the chosen blocks is in the built files.');
  for (const f of files) await writeFile(join(o.dir, f.name), f.prg);

  const args = packArgs(o.prefs, packInputs(parts), outName);
  const argv = [o.exe, ...args];
  const { code, output } = await runTool(o.exe, args, o.dir, o.timeoutMs ?? 120000);
  const report = parseExomizer(output);
  const image = packImage(parts);
  const packed = image && { start: image.start, length: image.bytes.length };
  const prg = code === 0 ? await readFile(join(o.dir, outName)).then(b => new Uint8Array(b), () => null) : null;
  if (!prg) {
    const error = report.errors[0] ?? (code == null ? 'Exomizer did not run.' : code === 0 ? 'Exomizer wrote no file.' : `Exomizer stopped with exit code ${code}.`);
    return { ok: false, code, output, argv, out: null, packed, report, check: null, error, ms: Date.now() - t0 };
  }

  let check: ExomizerResult['check'] = null;
  if (o.prefs.mode === 'sfx' && o.check !== false && image) {
    const cargs = ['desfx', '-o', DESFX_OUT, outName];
    const c = await runTool(o.exe, cargs, o.dir, o.timeoutMs ?? 120000);
    const b = await readFile(join(o.dir, DESFX_OUT)).then(x => new Uint8Array(x), () => null);
    const got = b && b.length >= 2 ? { load: b[0] | (b[1] << 8), bytes: b.subarray(2) } : null;
    // the start Exomizer reported (a jmp, or the SYS it found) is where the decruncher must go; RUN has none to compare
    const want = o.prefs.start === 'jmp' ? o.prefs.jmp : o.prefs.start === 'sys' ? report.entry : null;
    check = { ...checkDecrunched(image, got, { want, got: parseExomizer(c.output).entry }), argv: [o.exe, ...cargs], output: c.output };
  }
  return { ok: true, code, output, argv, out: { name: outName, prg }, packed, report, check, ms: Date.now() - t0 };
}
