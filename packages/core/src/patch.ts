/* Patches (spec 10.2): code the user writes over a range of the loaded bytes. It is assembled with the built-in
 * Kick-subset assembler at the range's start, with the program's labels, zero-page variables and the hardware
 * symbols at hand, and written over the bytes of the file that holds the range. A patch keeps the bytes it wrote
 * over, so it can be edited, switched off and removed again, and it can be saved as a PRG file of its own. */
import type { Addr, AnalysisResult, LoadedFile, Patch, PatchFill, Project, RenderResult, Settings } from './types';
import { assemble } from './verify/kick-subset-assembler';
import { hardwareInclude } from './render/include';
import { makePrg } from './c64/prg';
import { newId } from './project';
import { h4 } from './util/hex';

const NOP = 0xea;

export interface PatchRequest {
  name: string;
  /** the range it replaces, end excluded */
  start: Addr; end: Addr;
  source: string;
  fill: PatchFill;
  /** the code may write past the end of the range, over the bytes after it */
  over: boolean;
  /** the patch this edits: it is written again over the bytes it found, and only other patches are in the way */
  id?: string;
}

/** Where a line of the code is: the address its code starts at and how many bytes it is (0: a label, a comment). */
export interface PatchLine { addr: Addr; len: number }

/** The assembled code, line by line (null: the assembler did not get to the line), and its bytes from the start. */
export interface PatchCode { lines: (PatchLine | null)[]; code: Uint8Array }

export interface PatchPlan extends PatchCode {
  patch: Patch;
  /** how many bytes it writes past the range (only with `over`) */
  past: number;
}

/** What is wrong; `line` is the line of the code it is on (1 for the first). The code's lines and bytes are there as
 *  far as the assembler got, to show where each line goes while it is being written. */
export interface PatchError extends Partial<PatchCode> { error: string; line?: number }

/** the end of what patch `p` writes (excluded) */
export const patchEnd = (p: Pick<Patch, 'start' | 'bytes'>): Addr => p.start + p.bytes.length;

/** the patch whose range takes in `a` (switched off ones too) */
export const patchAt = (patches: readonly Patch[], a: Addr): Patch | undefined => patches.find(p => a >= p.start && a < patchEnd(p));

/** the patches that are on: their bytes are in the files */
export const patchesOn = <P extends Pick<Patch, 'off'>>(patches: readonly P[]): P[] => patches.filter(p => !p.off);

/** A name of its own for the patch's PRG file: letters, digits, `_`, `-` and `.` (anything else becomes `_`). */
export const patchFileName = (name: string): string => `${name.trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '') || 'patch'}.prg`;

/** The patch as a PRG: its load address and the bytes it writes. */
export const patchPrg = (p: Pick<Patch, 'start' | 'bytes'>): Uint8Array => makePrg(p.start, p.bytes);

/** the last file (as the analysis reads them, later files over earlier ones) that holds start..end whole */
function fileIndex(files: readonly Pick<LoadedFile, 'load' | 'bytes'>[], start: Addr, end: Addr): number {
  for (let i = files.length - 1; i >= 0; i--) { const f = files[i]; if (start >= f.load && end <= f.load + f.bytes.length) return i; }
  return -1;
}

/** `files` with `bytes` written at `start` in file `i` (a new array, and a new byte array for the file changed) */
function writeAt<F extends Pick<LoadedFile, 'load' | 'bytes'>>(files: readonly F[], i: number, start: Addr, bytes: Uint8Array): F[] {
  if (i < 0) throw new Error(`$${h4(start)}-$${h4(start + bytes.length - 1)} is not inside one loaded file`);
  const f = files[i], b = f.bytes.slice();
  b.set(bytes, start - f.load);
  return files.map((g, j) => (j === i ? { ...g, bytes: b } : g));
}

/** `files` with the patch written over them */
export const applyPatch = <F extends Pick<LoadedFile, 'load' | 'bytes'>>(files: readonly F[], p: Pick<Patch, 'start' | 'bytes'>): F[] =>
  writeAt(files, fileIndex(files, p.start, patchEnd(p)), p.start, p.bytes);

/** `files` with the bytes the patch wrote over back, in the file that holds the patch (a file added later over the
 *  same addresses is left alone) */
export function revertPatch<F extends Pick<LoadedFile, 'load' | 'bytes'>>(files: readonly F[], p: Pick<Patch, 'start' | 'bytes' | 'old'>): F[] {
  const holds = (f: F) => p.start >= f.load && patchEnd(p) <= f.load + f.bytes.length && p.bytes.every((b, k) => f.bytes[p.start - f.load + k] === b);
  let i = files.length - 1;
  while (i >= 0 && !holds(files[i])) i--;
  return writeAt(files, i >= 0 ? i : fileIndex(files, p.start, patchEnd(p)), p.start, p.old);
}

/** The files as they were loaded, every patch that is on taken out (the newest first). */
export function unpatchedFiles<F extends Pick<LoadedFile, 'load' | 'bytes'>>(files: readonly F[], patches: readonly Pick<Patch, 'start' | 'bytes' | 'old' | 'off'>[]): F[] {
  let out = [...files];
  for (const p of patchesOn(patches).reverse()) out = revertPatch(out, p);
  return out;
}

/** the names the code defines itself (labels, .label/.const/.var): the program's own of those names are left out */
function ownNames(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)) out.add(m[1]);
  for (const m of source.matchAll(/\.(?:label|const|var)\s+([A-Za-z_]\w*)/g)) out.add(m[1]);
  return out;
}

/** the label put before line `i` of the code, which tells where the line goes */
const lineLabel = (i: number) => `__mimir_line_${i}`;

/**
 * Assemble `source` at `start`, with the program's labels and zero-page variables (as the listing names them) and the
 * hardware symbols at hand; a name the code defines itself wins. Gives each line's address and length, and the bytes
 * from `start`, as far as the assembler got even when there is an error.
 */
export function assemblePatch(R: Pick<RenderResult, 'labels' | 'zp'>, settings: Pick<Settings, 'hexCase'>, start: Addr, source: string): PatchCode & { error?: string; line?: number } {
  const own = ownNames(source);
  const hw = hardwareInclude(settings).split('\n').filter(l => { const m = /^\.label\s+(\w+)/.exec(l); return !m || !own.has(m[1]); });
  const names: string[] = [];
  const seen = new Set<string>();
  const def = (n: string, a: Addr) => { if (!own.has(n) && !seen.has(n)) { seen.add(n); names.push(`.label ${n} = $${h4(a)}`); } };
  for (const [a, l] of R.labels) def(l.name, a);
  for (const [a, z] of R.zp) if (!z.off) def(z.name, a);
  // each line of the code after a label of its own: the label's value is where the line goes
  const user = source.split('\n');
  const head = ['#import "hardware.asm"', '#import "labels.asm"', `.pc = $${h4(start)} "patch"`];
  const body = user.flatMap((l, i) => [`${lineLabel(i)}:`, l]);
  const asm = assemble({ 'patch.asm': [...head, ...body, `${lineLabel(user.length)}:`].join('\n'), 'hardware.asm': hw.join('\n'), 'labels.asm': names.join('\n') }, 'patch.asm');
  const at = (i: number) => { const v = asm.symbols.get(lineLabel(i)); return typeof v === 'number' ? v : null; };
  const lines = user.map((_, i): PatchLine | null => {
    const a = at(i);
    if (a == null) return null;
    let next: number | null = null;
    for (let j = i + 1; j <= user.length && next == null; j++) next = at(j);
    return { addr: a, len: next != null && next >= a ? next - a : 0 };
  });
  const n = asm.min >= start ? asm.max - start + 1 : 0;
  const out = { lines, code: asm.mem.slice(start, start + n) };
  const err = asm.errors[0];
  if (err) {
    // a line of the code is line head + 2i + 2 of the file (after its label)
    const b = err.file === 'patch.asm' ? err.line - head.length - 1 : -1;
    const line = b >= 0 && b < body.length ? (b >> 1) + 1 : undefined;
    return { ...out, error: `${line ? `Line ${line}: ` : ''}${err.msg}`, ...(line ? { line } : {}) };
  }
  if (asm.min >= 0) {
    if (asm.min !== start) return { ...out, error: `The code must start at $${h4(start)}: it writes at $${h4(asm.min)} (a .pc or * = in it moves it).` };
    for (let a = start; a <= asm.max; a++) if (!asm.written[a]) return { ...out, error: `The code leaves $${h4(a)} unwritten; write it all in one piece from $${h4(start)}.` };
  }
  return out;
}

/**
 * Assemble the code of `req` at its start (assemblePatch) and check it against the range: it must stay in the file
 * that holds the range, it may only write past the range with `over`, and it may not touch another patch (one that
 * is switched off keeps its range). A shorter code leaves the rest of the range to the fill.
 */
export function planPatch(A: AnalysisResult, R: Pick<RenderResult, 'labels' | 'zp'>, project: Pick<Project, 'files' | 'patches'> & { settings: Pick<Settings, 'hexCase'> }, req: PatchRequest): PatchPlan | PatchError {
  const { start, end } = req;
  if (!(start >= 0 && start < end && end <= 0x10000)) return { error: 'The range is empty.' };
  const asm = assemblePatch(R, project.settings, start, req.source);
  const fail = (error: string): PatchError => ({ lines: asm.lines, code: asm.code, error });
  if (asm.error) return { lines: asm.lines, code: asm.code, error: asm.error, ...(asm.line ? { line: asm.line } : {}) };
  const name = req.name.trim();
  if (!name) return fail('Give the patch a name.');
  if (project.patches.some(p => p.id !== req.id && p.name.trim().toLowerCase() === name.toLowerCase())) return fail(`There is already a patch called "${name}".`);
  const file = A.owner[start];
  if (file < 0) return fail(`$${h4(start)} is not part of any loaded file.`);
  for (let a = start; a < end; a++) if (A.owner[a] !== file) return fail(`$${h4(start)}-$${h4(end - 1)} ${A.owner[a] < 0 ? 'runs past the end of the file' : 'crosses into another file'} at $${h4(a)}.`);
  const n = asm.code.length, size = end - start;
  if (n > size && !req.over) return fail(`The code is ${n} bytes, ${n - size} more than the ${size} of the original. Tick "Overwrite past the range" to write over the bytes after it.`);
  if (!n && req.fill === 'keep') return fail('Write the code that replaces the original (with no code, NOPs can fill the range).');
  const len = req.fill === 'nop' ? Math.max(n, size) : n;
  for (let a = end; a < start + len; a++) if (A.owner[a] !== file) return fail(`The code runs past the end of the file at $${h4(a)}.`);
  const other = project.patches.find(p => p.id !== req.id && p.start < start + len && patchEnd(p) > start);
  if (other) return fail(`It would write over the patch "${other.name}" ($${h4(other.start)}-$${h4(patchEnd(other) - 1)}${other.off ? ', switched off' : ''}).`);

  const bytes = new Uint8Array(len).fill(NOP);
  bytes.set(asm.code);
  // the bytes it writes over: as loaded, the patch being edited taken out first (when it is on)
  const edited = req.id ? project.patches.find(p => p.id === req.id) : undefined;
  const base = edited && !edited.off ? revertPatch(project.files, edited) : project.files;
  const f = base[fileIndex(base, start, start + len)];
  if (!f) return fail(`$${h4(start)}-$${h4(start + len - 1)} is not inside one loaded file.`);
  const old = f.bytes.slice(start - f.load, start - f.load + len);
  // with `keep` the bytes after the code stay as they are: the patch writes only the code
  const patch: Patch = { id: edited?.id ?? newId(), name, start, end, source: req.source, fill: req.fill, over: req.over, bytes, old, ...(edited?.off ? { off: true } : {}) };
  return { patch, lines: asm.lines, code: asm.code, past: Math.max(0, n - size) };
}

/** The project with the patch added or edited: written over the files when it is on (an edited one keeps on or off). */
export function withPatch<P extends Pick<Project, 'files' | 'patches'>>(project: P, patch: Patch): Pick<Project, 'files' | 'patches'> {
  const was = project.patches.find(p => p.id === patch.id);
  const base = was && !was.off ? revertPatch(project.files, was) : project.files;
  return { files: patch.off ? base : applyPatch(base, patch), patches: was ? project.patches.map(p => (p.id === patch.id ? patch : p)) : [...project.patches, patch] };
}

/** The project without the patch: the bytes it wrote over are back. */
export function withoutPatch<P extends Pick<Project, 'files' | 'patches'>>(project: P, id: string): Pick<Project, 'files' | 'patches'> {
  const p = project.patches.find(x => x.id === id);
  if (!p) return { files: project.files, patches: project.patches };
  return { files: p.off ? project.files : revertPatch(project.files, p), patches: project.patches.filter(x => x.id !== id) };
}

/** The project with the patch switched on (its bytes written again) or off (the bytes it wrote over back); it stays
 *  in the list, and keeps its range. */
export function switchPatch<P extends Pick<Project, 'files' | 'patches'>>(project: P, id: string, on: boolean): Pick<Project, 'files' | 'patches'> {
  const p = project.patches.find(x => x.id === id);
  if (!p || !p.off === on) return { files: project.files, patches: project.patches };
  const { off: _, ...q } = p;
  return { files: on ? applyPatch(project.files, p) : revertPatch(project.files, p), patches: project.patches.map(x => (x.id === id ? (on ? q : { ...q, off: true }) : x)) };
}
