/* Patches (spec 10.2): code the user writes over a range of the loaded bytes. It is assembled with the built-in
 * Kick-subset assembler at the range's start, with the program's labels, zero-page variables and the hardware
 * symbols at hand, and written over the bytes of the file that holds the range. A patch keeps the bytes it wrote
 * over, so it can be edited, switched off and removed again, and it can be saved as a PRG file of its own. */
import type { Addr, AnalysisResult, LoadedFile, Patch, PatchFill, Project, RenderResult, Settings } from './types';
import { assemble } from './verify/kick-subset-assembler';
import { hardwareInclude } from './render/include';
import { makePrg } from './c64/prg';
import { newId } from './project';
import { h2, h4 } from './util/hex';
import { instructionCycles } from './cpu/cycles';
import { OPC } from './cpu/opcodes';

const NOP = 0xea;

export interface PatchRequest {
  name: string;
  /** the range it replaces, end excluded */
  start: Addr; end: Addr;
  source: string;
  fill: PatchFill;
  /** the code may write past the end of the range, over the bytes after it */
  over: boolean;
  /** keep the cycle count: the patch must take as many cycles as the original, with instructions of a fixed time */
  cycles?: boolean;
  /** the patch this edits: it is written again over the bytes it found, and only other patches are in the way */
  id?: string;
}

/** Where a line of the code is: the address its code starts at and how many bytes it is (0: a label, a comment). */
export interface PatchLine { addr: Addr; len: number }

/** The assembled code, line by line (null: the assembler did not get to the line), and its bytes from the start. */
export interface PatchCode { lines: (PatchLine | null)[]; code: Uint8Array }

/**
 * The time of the patched bytes against the original's, both run straight through from the start to the end of the
 * range (or of the patch, when it writes past it): the new code with its fill, the original's instructions there.
 * Counted without page crossings and with branches not taken; `originalMost` is the most the original can take.
 */
export interface PatchTime {
  original: number; originalMost: number;
  now: number;
  /** the first instruction of the code whose time is not fixed: a branch, an indexed read that can cross a page */
  varies?: { line?: number; why: string };
}

export interface PatchPlan extends PatchCode {
  patch: Patch;
  /** how many bytes it writes past the range (only with `over`) */
  past: number;
  /** with the cycle count kept */
  time?: PatchTime;
}

/** What is wrong; `line` is the line of the code it is on (1 for the first). The code's lines and bytes are there as
 *  far as the assembler got, to show where each line goes while it is being written. */
export interface PatchError extends Partial<PatchCode> { error: string; line?: number; time?: PatchTime }

/** the instructions of `bytes` at `at`, run straight through: each one's address and cycles */
function stepsOf(bytes: Uint8Array, at: Addr) {
  const mem = new Uint8Array(0x10000);
  mem.set(bytes.subarray(0, 0x10000 - at), at);
  const out: { pc: Addr; c: ReturnType<typeof instructionCycles> }[] = [];
  for (let pc = at; pc < at + bytes.length; pc += OPC[mem[pc]].len) out.push({ pc, c: instructionCycles(mem, pc) });
  return out;
}

/** the cycles of `bytes` at `at` run straight through, and the most they can take (page crossings, branches taken) */
export function straightCycles(bytes: Uint8Array, at: Addr): { cycles: number; most: number } {
  let cycles = 0, most = 0;
  for (const { c } of stepsOf(bytes, at)) { cycles += c.base; most += c.taken ?? c.base + (c.page ? 1 : 0); }
  return { cycles, most };
}

/** the end of what patch `p` writes (excluded) */
export const patchEnd = (p: Pick<Patch, 'start' | 'bytes'>): Addr => p.start + p.bytes.length;

/** the patch whose range takes in `a` (switched off ones too) */
export const patchAt = (patches: readonly Patch[], a: Addr): Patch | undefined => patches.find(p => a >= p.start && a < patchEnd(p));

/** the patches that are on: their bytes are in the files */
export const patchesOn = <P extends Pick<Patch, 'off'>>(patches: readonly P[]): P[] => patches.filter(p => !p.off);

/** A name of its own for the patch's file (its PRG, or its source in the export): letters, digits, `_`, `-` and `.`
 *  (anything else becomes `_`). */
export const patchFileName = (name: string, ext: 'prg' | 'asm' = 'prg'): string => `${name.trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '') || 'patch'}.${ext}`;

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

/** the names code may use: the hardware symbols, and the program's labels and zero-page variables as the listing
 *  names them */
function namesFor(R: Pick<RenderResult, 'labels' | 'zp'>, settings: Pick<Settings, 'hexCase'>): Map<string, Addr> {
  const out = new Map<string, Addr>();
  for (const m of hardwareInclude(settings).matchAll(/^\.label\s+(\w+)\s*=\s*\$([0-9a-f]+)/gim)) out.set(m[1], parseInt(m[2], 16));
  for (const [a, l] of R.labels) if (!out.has(l.name)) out.set(l.name, a);
  for (const [a, z] of R.zp) if (!z.off && !out.has(z.name)) out.set(z.name, a);
  return out;
}

/** the words of the code that can be names: not in comments or strings, not directives, numbers or local labels */
function usedNames(source: string): Set<string> {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return new Set([...code.matchAll(/(?<![.\w$%!])[A-Za-z_]\w*/g)].map(m => m[0]));
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
  const names = [...namesFor(R, settings)].filter(([n]) => !own.has(n)).map(([n, a]) => `.label ${n} = $${h4(a)}`);
  // each line of the code after a label of its own: the label's value is where the line goes
  const user = source.split('\n');
  const head = ['#import "names.asm"', `.pc = $${h4(start)} "patch"`];
  const body = user.flatMap((l, i) => [`${lineLabel(i)}:`, l]);
  const asm = assemble({ 'patch.asm': [...head, ...body, `${lineLabel(user.length)}:`].join('\n'), 'names.asm': names.join('\n') }, 'patch.asm');
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
  let time: PatchTime | undefined;
  const fail = (error: string): PatchError => ({ lines: asm.lines, code: asm.code, error, ...(time ? { time } : {}) });
  if (asm.error) return { lines: asm.lines, code: asm.code, error: asm.error, ...(asm.line ? { line: asm.line } : {}) };
  const name = req.name.trim();
  const file = A.owner[start];
  if (file < 0) return fail(`$${h4(start)} is not part of any loaded file.`);
  for (let a = start; a < end; a++) if (A.owner[a] !== file) return fail(`$${h4(start)}-$${h4(end - 1)} ${A.owner[a] < 0 ? 'runs past the end of the file' : 'crosses into another file'} at $${h4(a)}.`);
  const n = asm.code.length, size = end - start;
  const len = req.fill === 'nop' ? Math.max(n, size) : n;
  // the bytes it writes over: as loaded, the patch being edited taken out first (when it is on)
  const edited = req.id ? project.patches.find(p => p.id === req.id) : undefined;
  const base = edited && !edited.off ? revertPatch(project.files, edited) : project.files;
  if (req.cycles) time = patchTime(base, req, asm);

  if (!name) return fail('Give the patch a name.');
  if (project.patches.some(p => p.id !== req.id && p.name.trim().toLowerCase() === name.toLowerCase())) return fail(`There is already a patch called "${name}".`);
  if (n > size && !req.over) return fail(`The code is ${n} bytes, ${n - size} more than the ${size} of the original. Tick "Overwrite past the range" to write over the bytes after it.`);
  if (!n && req.fill === 'keep') return fail('Write the code that replaces the original (with no code, NOPs can fill the range).');
  for (let a = end; a < start + len; a++) if (A.owner[a] !== file) return fail(`The code runs past the end of the file at $${h4(a)}.`);
  const other = project.patches.find(p => p.id !== req.id && p.start < start + len && patchEnd(p) > start);
  if (other) return fail(`It would write over the patch "${other.name}" ($${h4(other.start)}-$${h4(patchEnd(other) - 1)}${other.off ? ', switched off' : ''}).`);
  if (time?.varies) {
    const { line, why } = time.varies, text = line ? req.source.split('\n')[line - 1]?.replace(/\/\/.*$/, '').trim() : '';
    return { ...fail(`${line ? `Line ${line}: ${text} ` : 'An instruction '}${why}. Keeping the cycle count needs instructions that take a fixed time.`), ...(line ? { line } : {}) };
  }
  if (time && time.now !== time.original) {
    const d = time.original - time.now;
    return fail(d > 0 ? `The patch takes ${time.now} cycles, ${d} fewer than the ${time.original} of the original: ${d} left to use.` : `The patch takes ${time.now} cycles, ${-d} more than the ${time.original} of the original.`);
  }

  const bytes = new Uint8Array(len).fill(NOP);
  bytes.set(asm.code);
  const f = base[fileIndex(base, start, start + len)];
  if (!f) return fail(`$${h4(start)}-$${h4(start + len - 1)} is not inside one loaded file.`);
  const old = f.bytes.slice(start - f.load, start - f.load + len);
  // with `keep` the bytes after the code stay as they are: the patch writes only the code
  const patch: Patch = { id: edited?.id ?? newId(), name, start, end, source: req.source, fill: req.fill, over: req.over, bytes, old, ...(req.cycles ? { cycles: true } : {}), ...(edited?.off ? { off: true } : {}) };
  return { patch, lines: asm.lines, code: asm.code, past: Math.max(0, n - size), ...(time ? { time } : {}) };
}

/**
 * The time of the patch against the original's (PatchTime): the bytes from the start to the end of the range, or of
 * the code when it is longer, run straight through, as the original has them and as they are with the code and its
 * fill (with `keep`, the original's bytes after the code). The code's own instructions must take a fixed time.
 */
function patchTime(files: readonly Pick<LoadedFile, 'load' | 'bytes'>[], req: PatchRequest, asm: PatchCode): PatchTime | undefined {
  const { start, end } = req, n = asm.code.length, len = req.fill === 'nop' ? Math.max(n, end - start) : n;
  const f = files[fileIndex(files, start, end)];
  if (!f) return undefined;
  const span = Math.min(Math.max(end, start + len), f.load + f.bytes.length);
  const original = f.bytes.slice(start - f.load, span - f.load);
  const now = original.slice();
  for (let i = 0; i < Math.min(len, now.length); i++) now[i] = i < n ? asm.code[i] : NOP;
  const o = straightCycles(original, start), w = straightCycles(now, start);
  const time: PatchTime = { original: o.cycles, originalMost: o.most, now: w.cycles };
  for (const { pc, c } of stepsOf(asm.code, start)) {
    if (!c.page && c.taken == null && !c.jam) continue;
    const i = asm.lines.findIndex(l => !!l && l.len > 0 && pc >= l.addr && pc < l.addr + l.len);
    const why = c.jam ? 'stops the CPU' : c.taken != null ? `takes ${c.base} or ${c.taken} cycles (a branch, not taken or taken)` : `takes ${c.base} or ${c.base + 1} cycles (one more when the index crosses a page)`;
    time.varies = { ...(i >= 0 ? { line: i + 1 } : {}), why };
    break;
  }
  return time;
}

/**
 * The patch as a Kick Assembler source of its own (patches/<name>.asm in the export): the names its code uses as
 * `.label` lines, then the code at its address and the fill, which assembles to the bytes the patch writes. When the
 * code no longer gives those bytes with the program's names (a label renamed since, say), the source has the bytes as
 * `.byte` lines and the code as a comment. `from`: the name of the file the patch is written over.
 */
export function patchSource(R: Pick<RenderResult, 'labels' | 'zp'>, settings: Pick<Settings, 'hexCase'>, p: Patch, from?: string): string {
  const head = [
    `// Patch "${p.name}" by Mimir Studio: $${h4(p.start)}-$${h4(patchEnd(p) - 1)}${from ? ` of ${from}` : ''}, ${p.bytes.length} byte${p.bytes.length === 1 ? '' : 's'} written over the original${p.off ? ' (switched off: not in the sources)' : ''}`,
    `// It assembles on its own to a PRG that loads at $${h4(p.start)}: java -jar KickAss.jar ${patchFileName(p.name, 'asm')}`, ''];
  const pc = `.pc = $${h4(p.start)} "${p.name.replace(/["\\]/g, "'")}"`;
  const now = assemblePatch(R, settings, p.start, p.source), n = now.code.length;
  const same = !now.error && n <= p.bytes.length && now.code.every((b, i) => b === p.bytes[i]) && p.bytes.subarray(n).every(b => b === NOP);
  if (same) {
    const all = namesFor(R, settings), own = ownNames(p.source);
    const defs = [...usedNames(p.source)].filter(u => all.has(u) && !own.has(u)).sort().map(u => `.label ${u} = $${h4(all.get(u)!)}`);
    const indent = /^([ \t]+)\S/m.exec(p.source)?.[1] ?? '        ', rest = p.bytes.length - n;
    return [...head, ...(defs.length ? ['// the names the code uses, from the program and the C64 hardware', ...defs, ''] : []), pc,
      p.source.replace(/\s+$/, ''), ...(rest ? [`${indent}.fill ${rest}, $ea              // the rest of the range: NOP`] : []), ''].join('\n');
  }
  const rows: string[] = [];
  for (let i = 0; i < p.bytes.length; i += 8) rows.push(`        .byte ${[...p.bytes.subarray(i, i + 8)].map(b => `$${h2(b)}`).join(', ')}`);
  return [...head, '// The code no longer assembles to these bytes with the program\'s names (a label renamed since?),',
    '// so here are the bytes the patch writes. The code as it was written:', ...p.source.split('\n').map(l => `//   ${l}`), '', pc, ...rows, ''].join('\n');
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
