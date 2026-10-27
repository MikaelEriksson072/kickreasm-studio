/* The VICE monitor's memory dump (spec 14.6), as x64sc 3.10 prints it: `m` writes a row as
 * `>C:0801  0b 08 0a 00  9e 32 30 36  34 00 00 00  00 00 00 20   ....2064.......`, 16 bytes in groups of four and then
 * the same bytes as text; `i` writes 40 bytes a row as PETSCII text and `ii` as screen codes (`*C:`). VICE's monitor
 * draws the text with the C64 font; here a byte becomes the character the C64 shows, and `.` when it is a control code
 * or a graphics character. */
import type { Addr } from '../types';
import { h2, h4 } from '../util/hex';

export type MonitorMode = 'm' | 'i' | 'ii';
/** a range of memory, `end` exclusive */
export interface MonitorRange { start: Addr; end: Addr }
/** a row of the dump: its address and how many bytes it shows */
export interface MonitorRow { a: Addr; n: number }

/** bytes per row as VICE prints them in an 80-column monitor: 16 for `m`, 40 for `i` and `ii` */
export const MONITOR_ROW: Record<MonitorMode, number> = { m: 16, i: 40, ii: 40 };

/** The loaded parts of memory (`owner[a] >= 0`), in address order. */
export function loadedRanges(owner: ArrayLike<number>): MonitorRange[] {
  const out: MonitorRange[] = [];
  for (let a = 0; a < 0x10000; a++) {
    if (owner[a] < 0) continue;
    const start = a;
    while (a < 0x10000 && owner[a] >= 0) a++;
    out.push({ start, end: a });
  }
  return out;
}

/**
 * The rows of each range. VICE starts them at the address of the command (`m 0985` has rows at $0985, $0995, …), not
 * at a multiple of 16: `origin` is that address, and a range starting between two rows begins with a shorter one.
 * Without it the rows start at each range's start.
 */
export function monitorRows(ranges: readonly MonitorRange[], perRow: number, origin?: Addr): MonitorRow[] {
  const rows: MonitorRow[] = [];
  for (const r of ranges) {
    let a = r.start;
    const lead = origin == null ? 0 : (((origin - r.start) % perRow) + perRow) % perRow;
    if (lead) { const n = Math.min(lead, r.end - a); rows.push({ a, n }); a += n; }
    for (; a < r.end; a += perRow) rows.push({ a, n: Math.min(perRow, r.end - a) });
  }
  return rows;
}

export interface MonitorChar { ch: string; inv?: boolean }

/** A screen code ($00-$7f) as the C64 shows it, upper case/graphics or lower case set; null for a graphics character. */
function screenChar(s: number, lower: boolean): string | null {
  if (s === 0x00) return '@';
  if (s <= 0x1a) return String.fromCharCode((lower ? 0x60 : 0x40) + s);
  if (s <= 0x1f) return ['[', '£', ']', '↑', '←'][s - 0x1b];
  if (s <= 0x3f) return String.fromCharCode(s);
  if (lower && s >= 0x41 && s <= 0x5a) return String.fromCharCode(s);
  if (!lower && s === 0x5e) return 'π';
  if (s === 0x60) return ' ';
  return null;
}

/** PETSCII as the screen code the C64 draws for it; null for the control codes $00-$1f and $80-$9f. */
export function petsciiToScreen(b: number): number | null {
  if (b < 0x20 || (b >= 0x80 && b < 0xa0)) return null;
  if (b < 0x40) return b;
  if (b < 0x60) return b - 0x40;
  if (b < 0x80) return b - 0x20;
  if (b < 0xc0) return b - 0x40;
  if (b === 0xff) return 0x5e;
  return b - 0x80;
}

/**
 * How the C64 shows a byte as text: as PETSCII (`m`, `i`) or as a screen code (`ii`, where $80-$ff are the inverse of
 * $00-$7f), in the upper case/graphics character set or the lower case one. null: written as `.`.
 */
export function monitorChar(b: number, screen: boolean, lower = false): MonitorChar | null {
  if (screen) {
    const ch = screenChar(b & 0x7f, lower);
    return ch == null ? null : b >= 0x80 ? { ch, inv: true } : { ch };
  }
  const s = petsciiToScreen(b);
  const ch = s == null ? null : screenChar(s, lower);
  return ch == null ? null : { ch };
}

/** The row's text column: a character per byte, `.` for one the C64 shows as a control code or graphics. */
export const monitorTextOf = (mem: ArrayLike<number>, row: MonitorRow, screen: boolean, lower = false): string =>
  Array.from({ length: row.n }, (_, i) => monitorChar(mem[(row.a + i) & 0xffff], screen, lower)?.ch ?? '.').join('');

/** The row's hex column for `m`: groups of four, a short last row padded so the text column stays in place. */
export function monitorHexOf(mem: ArrayLike<number>, row: MonitorRow, perRow = MONITOR_ROW.m): string {
  const groups: string[] = [];
  for (let g = 0; g < perRow; g += 4) {
    const bytes: string[] = [];
    for (let i = g; i < Math.min(g + 4, perRow); i++) bytes.push(i < row.n ? h2(mem[(row.a + i) & 0xffff]) : '  ');
    groups.push(bytes.join(' '));
  }
  return groups.join('  ');
}

/** `>C:0801  ` for `m` and `i`, `*C:0801  ` for `ii`, as VICE starts the rows */
export const monitorPrefix = (mode: MonitorMode, a: Addr): string => `${mode === 'ii' ? '*' : '>'}C:${h4(a)}  `;

/** A row as VICE prints it. `lower`: the lower case character set; `perRow`: bytes per `m` row (16, or 8 like a 40-column monitor). */
export function monitorLine(mem: ArrayLike<number>, row: MonitorRow, mode: MonitorMode, opts: { lower?: boolean; perRow?: number } = {}): string {
  const text = monitorTextOf(mem, row, mode === 'ii', opts.lower);
  if (mode !== 'm') return monitorPrefix(mode, row.a) + text.padEnd(MONITOR_ROW[mode]);
  return `${monitorPrefix(mode, row.a)}${monitorHexOf(mem, row, opts.perRow)}   ${text}`;
}

/** The dump of the loaded parts of [start, end) as text, one row a line (what Copy puts on the clipboard). */
export function monitorText(mem: ArrayLike<number>, ranges: readonly MonitorRange[], mode: MonitorMode, opts: { lower?: boolean; perRow?: number } = {}): string {
  const perRow = mode === 'm' ? opts.perRow ?? MONITOR_ROW.m : MONITOR_ROW[mode];
  return monitorRows(ranges, perRow).map(r => monitorLine(mem, r, mode, { ...opts, perRow })).join('\n');
}

/** The parts of `ranges` inside [start, end). */
export const clipRanges = (ranges: readonly MonitorRange[], start: Addr, end: Addr): MonitorRange[] =>
  ranges.map(r => ({ start: Math.max(r.start, start), end: Math.min(r.end, end) })).filter(r => r.end > r.start);

/** A search hit: its bytes, and how they matched (text as PETSCII, as screen codes or as both, or bytes). */
export interface MemoryMatch { start: Addr; end: Addr; as: 'petscii' | 'screen' | 'both' | 'bytes' }
export type FindAs = 'text' | 'bytes';
/** the most hits one search gives */
export const MAX_MATCHES = 5000;

/**
 * Searches the loaded memory. Text matches the characters the Memory tab shows (in the upper or the lower case
 * character set), ignoring case and inverse, both as PETSCII and as screen codes. Bytes are hex pairs (`a9 00 8d`,
 * `$a9,$00`, `a9008d`) and `??` for any byte. A hit never crosses the end of a loaded range; `more` says the search
 * stopped at MAX_MATCHES.
 */
export function findInMemory(mem: ArrayLike<number>, ranges: readonly MonitorRange[], query: string, as: FindAs, lower = false): { matches: MemoryMatch[]; more: boolean } | { error: string } {
  const matches: MemoryMatch[] = [];
  let more = false;
  if (as === 'bytes') {
    const pat: (number | null)[] = [];
    for (const t of query.replace(/\$/g, ' ').split(/[\s,]+/).filter(Boolean)) {
      if (/^(\?\??|\*)$/.test(t)) { pat.push(null); continue; }
      if (!/^[0-9a-f]+$/i.test(t) || t.length % 2) return { error: `"${t}" is not a byte: write hex pairs (a9 00 8d), and ?? for any byte.` };
      for (let i = 0; i < t.length; i += 2) pat.push(parseInt(t.slice(i, i + 2), 16));
    }
    if (pat.length && pat.every(p => p == null)) return { error: 'Give at least one byte, not only ??.' };
    if (pat.length) for (const r of ranges) {
      for (let a = r.start; a + pat.length <= r.end; a++) {
        let ok = true;
        for (let i = 0; ok && i < pat.length; i++) if (pat[i] != null && mem[a + i] !== pat[i]) ok = false;
        if (!ok) continue;
        if (matches.length === MAX_MATCHES) { more = true; break; }
        matches.push({ start: a, end: a + pat.length, as: 'bytes' });
      }
    }
    return { matches, more };
  }
  const q = [...query.toLowerCase()];
  if (!q.length) return { matches, more };
  const char = (b: number, screen: boolean) => monitorChar(b, screen, lower)?.ch.toLowerCase() ?? null;
  for (const r of ranges) {
    for (let a = r.start; a + q.length <= r.end; a++) {
      let pet = true, scr = true;
      for (let i = 0; (pet || scr) && i < q.length; i++) {
        if (pet && char(mem[a + i], false) !== q[i]) pet = false;
        if (scr && char(mem[a + i], true) !== q[i]) scr = false;
      }
      if (!pet && !scr) continue;
      if (matches.length === MAX_MATCHES) { more = true; break; }
      matches.push({ start: a, end: a + q.length, as: pet && scr ? 'both' : pet ? 'petscii' : 'screen' });
    }
  }
  return { matches, more };
}

/** `start` missing: the mode only (`ii` alone), the dump stays where it is */
export type MonitorCommand = { mode?: MonitorMode; start?: Addr; end?: Addr } | { error: string };

/**
 * A VICE monitor command for the dump: `m 0801 08ff`, `i 0801`, `ii 0400 07e7`, or an address or label alone. Addresses
 * are hex, with or without `$`; a label may start with `.` as in VICE. The end is inclusive, as in VICE (`end` here is
 * one past it). `0801-08ff` works too.
 */
export function parseMonitorCommand(input: string, labelAt?: (name: string) => Addr | undefined): MonitorCommand {
  const words = input.trim().replace(/\s*-\s*/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return { error: 'Type m, i or ii and an address, like m 0801 08ff.' };
  let mode: MonitorMode | undefined;
  const w0 = words[0].toLowerCase();
  if (w0 === 'm' || w0 === 'mem' || w0 === 'i' || w0 === 'ii') { mode = w0 === 'mem' ? 'm' : w0; words.shift(); }
  if (words.length > 2) return { error: 'At most a start and an end address.' };
  const addr = (w: string): Addr | string => {
    const hex = /^\$?([0-9a-f]{1,4})$/i.exec(w);
    const label = labelAt?.(w.replace(/^\./, ''));
    if (label != null) return label;
    if (hex) return parseInt(hex[1], 16);
    return `“${w}” is neither a hex address nor a label.`;
  };
  if (!words.length) return mode ? { mode } : { error: 'Type an address, like 0801.' };
  const s = addr(words[0]);
  if (typeof s === 'string') return { error: s };
  if (words.length === 1) return { ...(mode ? { mode } : {}), start: s };
  const e = addr(words[1]);
  if (typeof e === 'string') return { error: e };
  if (e < s) return { error: `The end $${h4(e)} is before the start $${h4(s)}.` };
  return { ...(mode ? { mode } : {}), start: s, end: e + 1 };
}
