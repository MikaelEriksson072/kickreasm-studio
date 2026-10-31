/* Packing with Exomizer 3 (spec 13.8): what is packed (the built PRGs whole, or address ranges of them), the command
 * line that packs it, what Exomizer reports, and the check that a self-extracting file decrunches to the same bytes.
 * Pure: the main process and the tests run the tool (node/exomizer.ts); the Pack view shows the same command. */
import type { Addr, PackPrefs, PackRange } from './types';
import { splitArgs } from './util/args';
import { h2, h4 } from './util/hex';

export const DEFAULT_PACK: PackPrefs = {
  packer: 'brokkr', effort: 'normal', format: 'exomizer', mode: 'sfx', ranges: null, start: 'sys', jmp: null, effect: 'default', ramExit: null, irqExit: null,
  memLoad: 'auto', forward: false, compat: false, fast: false, extra: '', out: '',
};

/** a built PRG as Exomizer gets it: its file name in the pack folder, load address and bytes (without the address) */
export interface PackFile { name: string; load: Addr; bytes: Uint8Array }

/** what Exomizer loads from one file: `name,$start,offset,length` (or the whole file) */
export interface PackPart { name: string; start: Addr; offset: number; bytes: Uint8Array; whole: boolean }

/** A file name Exomizer reads as one name: letters, digits, `._-` and spaces (no `,` or `@`, which start its options). */
export const packFileName = (name: string, ext = '.prg'): string =>
  `${name.replace(/\.(prg|bin)$/i, '').replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[. ]+|[. ]+$/g, '') || 'packed'}${ext}`;

/** Sorted ranges with the overlapping and touching ones joined. */
export function mergeRanges(ranges: readonly PackRange[]): PackRange[] {
  const out: PackRange[] = [];
  for (const r of [...ranges].filter(r => r.end > r.start).sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** `ranges` with [start, end) added (`on`) or taken out. */
export function editRanges(ranges: readonly PackRange[], start: Addr, end: Addr, on: boolean): PackRange[] {
  if (on) return mergeRanges([...ranges, { start, end }]);
  const out: PackRange[] = [];
  for (const r of mergeRanges(ranges)) {
    if (r.end <= start || r.start >= end) { out.push(r); continue; }
    if (r.start < start) out.push({ start: r.start, end: start });
    if (r.end > end) out.push({ start: end, end: r.end });
  }
  return out;
}

/** How many of the bytes in [start, end) the ranges cover. */
export function rangeCover(ranges: readonly PackRange[], start: Addr, end: Addr): number {
  let n = 0;
  for (const r of ranges) n += Math.max(0, Math.min(r.end, end) - Math.max(r.start, start));
  return n;
}

/** The parts of the files that are packed, file by file in order (Exomizer loads them so: a later one wins). */
export function packParts(ranges: readonly PackRange[] | null, files: readonly PackFile[]): PackPart[] {
  if (!ranges) return files.map(f => ({ name: f.name, start: f.load, offset: 0, bytes: f.bytes, whole: true }));
  const merged = mergeRanges(ranges), out: PackPart[] = [];
  for (const f of files) for (const r of merged) {
    const s = Math.max(r.start, f.load), e = Math.min(r.end, f.load + f.bytes.length);
    if (e > s) out.push({ name: f.name, start: s, offset: s - f.load, bytes: f.bytes.subarray(s - f.load, e - f.load), whole: false });
  }
  return out;
}

/** Exomizer's in-file arguments: `file.prg` for a whole PRG, `file.prg,$0810,14,1000` for a range of one. */
export const packInputs = (parts: readonly PackPart[], dir = ''): string[] =>
  parts.map(p => `${dir}${p.name}${p.whole ? '' : `,$${h4(p.start)},${p.offset},${p.bytes.length}`}`);

/** The memory Exomizer crunches: everything it loads, gaps between the parts zero-filled. */
export function packImage(parts: readonly { start: Addr; bytes: Uint8Array }[]): { start: Addr; bytes: Uint8Array } | null {
  if (!parts.length) return null;
  const start = Math.min(...parts.map(p => p.start)), end = Math.max(...parts.map(p => p.start + p.bytes.length));
  const bytes = new Uint8Array(end - start);
  for (const p of parts) bytes.set(p.bytes, p.start - start);
  return { start, bytes };
}

/** Exomizer options that are no options: a path, `-o` (the app names the files) or `--`. null: fine. */
export function extraProblem(extra: string): string | null {
  for (const t of splitArgs(extra)) {
    if (/^-o/.test(t)) return '-o is set by the app: name the packed file in “Packed file”.';
    if (t === '--') return '-- is not allowed: the files to pack come from what you choose.';
    if (/[\\/:@]|\.\./.test(t)) return `“${t}” looks like a path: Exomizer runs in a folder of its own, so the extra options take no files.`;
  }
  return null;
}

/** What is wrong with the settings, or null: they pack. */
export function packProblem(p: PackPrefs): string | null {
  if (p.ranges && !p.ranges.some(r => r.end > r.start)) return 'Choose the blocks to pack (or pack the whole build).';
  if (p.mode === 'sfx' && p.start === 'jmp' && p.jmp == null) return 'Enter the address the program starts at after decrunching.';
  return extraProblem(p.extra);
}

/** The packed file's name: the one typed (made safe), else <first file>-brokkr.prg or -exo.prg (.bin for a mem file
 * without load address). */
export function packOutName(p: PackPrefs, first: string): string {
  const ext = p.mode === 'mem' && p.memLoad === 'none' ? '.bin' : '.prg';
  const typed = p.out.trim();
  if (typed) return packFileName(typed, /\.(prg|bin)$/i.exec(typed)?.[0].toLowerCase() ?? ext);
  return packFileName(`${first.replace(/\.prg$/i, '')}-${p.packer === 'exomizer' ? 'exo' : 'brokkr'}`, ext);
}

/** Exomizer's arguments (without the executable): the sub command, its options, `-o out`, then the in-files. */
export function packArgs(p: PackPrefs, inputs: readonly string[], out: string): string[] {
  const args: string[] = [p.mode];
  if (p.mode === 'sfx') {
    args.push(p.start === 'jmp' ? `$${h4(p.jmp ?? 0)}` : p.start);
    if (p.effect === 'none') args.push('-n'); else if (p.effect !== 'default') args.push(`-${p.effect}`);
    if (p.ramExit != null) args.push(`-Di_ram_exit=$${h2(p.ramExit)}`);
    if (p.irqExit != null) args.push(`-Di_irq_exit=${p.irqExit ? 1 : 0}`);
  } else {
    if (p.memLoad !== 'auto') args.push('-l', p.memLoad === 'none' ? 'none' : `$${h4(p.memLoad)}`);
    if (p.forward) args.push('-f');
  }
  if (p.compat) args.push('-c');
  if (p.fast) args.push('-C');
  return [...args, ...splitArgs(p.extra), '-o', out, ...inputs];
}

/** An argument as typed on a command line: quoted when it has spaces. */
export const shellWord = (a: string): string => (/[\s"]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a);

export interface ExomizerArea { name: string; start: Addr; end: Addr; note?: string }
/** What Exomizer printed: the crunched size, the file it wrote, its memory layout and decruncher settings, errors. */
export interface ExomizerReport {
  /** "Length of crunched data: N bytes" */
  crunched: number | null;
  /** "Writing "x" as prg, saving from $a to $b" (end exclusive) */
  saved: { start: Addr; end: Addr } | null;
  /** the "Memory layout" table: crunched and decrunched data, decrunch table, decruncher (end exclusive) */
  layout: ExomizerArea[];
  /** the "Decruncher" table: RAM config and IRQ enabled on enter, during and after decrunching */
  decruncher: { what: string; enter: string; during: string; exit: string }[];
  /** "jmp address $0810" (sfx), or desfx's "entry1 at $0810" */
  entry: Addr | null;
  errors: string[];
}

const hex = (s: string) => parseInt(s, 16);

export function parseExomizer(output: string): ExomizerReport {
  const r: ExomizerReport = { crunched: null, saved: null, layout: [], decruncher: [], entry: null, errors: [] };
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^Length of crunched data:\s*(\d+)/i.exec(line))) r.crunched = +m[1];
    else if ((m = /saving from \$([0-9a-f]{1,4}) to \$([0-9a-f]{1,4})/i.exec(line))) {
      r.saved = { start: hex(m[1]), end: hex(m[2]) };
      const e = /entry\d* at \$([0-9a-f]{1,4})/i.exec(line);
      if (e) r.entry = hex(e[1]);
    } else if ((m = /^jmp address \$([0-9a-f]{1,4})/i.exec(line))) r.entry = hex(m[1]);
    else if ((m = /^([A-Za-z][A-Za-z ]+?)\s*\|\s*\$([0-9a-f]{4})\s*\|\s*\$([0-9a-f]{4})\s*\|\s*(.*)$/i.exec(line))) {
      r.layout.push({ name: m[1].trim(), start: hex(m[2]), end: hex(m[3]), ...(m[4].trim() ? { note: m[4].trim() } : {}) });
    } else if ((m = /^(RAM config|IRQ enabled)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|/i.exec(line))) {
      r.decruncher.push({ what: m[1], enter: m[2], during: m[3], exit: m[4] });
    } else if (/^(error|fatal)\b|\berror:/i.test(line)) r.errors.push(line);
  }
  return r;
}

/** The check of a packed sfx file: Exomizer's desfx ran its decruncher; did it write the bytes that were packed? */
export interface PackCheck {
  /** same: identical; differs: not; unchecked: desfx did not give the packed area (its result is shown) */
  status: 'same' | 'differs' | 'unchecked';
  text: string;
}

/**
 * Compare what desfx wrote (`got`: load address and bytes, the largest area the decruncher wrote) with the memory
 * that was packed. desfx keeps the largest written area, which for a small program can be the decruncher's own copy.
 */
export function checkDecrunched(want: { start: Addr; bytes: Uint8Array }, got: { load: Addr; bytes: Uint8Array } | null,
  entry: { want: Addr | null; got: Addr | null } = { want: null, got: null }): PackCheck {
  const range = `$${h4(want.start)}–$${h4(want.start + want.bytes.length - 1)}`;
  if (!got) return { status: 'unchecked', text: 'desfx wrote no file, so the decrunched bytes were not compared.' };
  const off = want.start - got.load;
  if (off < 0 || off + want.bytes.length > got.bytes.length) {
    const own = want.bytes.length < got.bytes.length ? ' (for so few bytes, the decruncher\'s own copy)' : '';
    return { status: 'unchecked', text: `desfx keeps the largest area the decruncher wrote, $${h4(got.load)}–$${h4(got.load + got.bytes.length - 1)}${own}, not the packed ${range}: the bytes were not compared.` };
  }
  for (let i = 0; i < want.bytes.length; i++) {
    if (got.bytes[off + i] !== want.bytes[i]) {
      const a = want.start + i;
      return { status: 'differs', text: `Decrunched byte at $${h4(a)} is $${h2(got.bytes[off + i])}, packed was $${h2(want.bytes[i])}.` };
    }
  }
  if (entry.want != null && entry.got != null && entry.want !== entry.got) {
    return { status: 'differs', text: `${range} decrunches to the same bytes, but it starts at $${h4(entry.got)} instead of $${h4(entry.want)}.` };
  }
  return { status: 'same', text: `Decrunched by desfx: ${range} has the same ${want.bytes.length} bytes${entry.got != null ? `, and it starts at $${h4(entry.got)}` : ''}.` };
}
