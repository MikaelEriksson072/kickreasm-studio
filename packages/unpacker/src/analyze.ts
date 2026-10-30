/* What a layer did, from the per-byte records the C64 keeps: the code it ran, the data it read and the bytes it
 * wrote. From that: what kind of layer it is (a decoder, a mover, a decruncher), a fingerprint of its code, the text
 * in and around it, and the packer it matches in the signature list. */
import type { C64 } from './c64.ts';
import signatures from '../data/signatures.json' with { type: 'json' };

export interface Range { start: number; end: number }

export type Kind = 'jump' | 'mover' | 'decoder' | 'decruncher' | 'program';

export interface Activity {
  /** the instructions it ran */
  code: Range[];
  instructions: number;
  /** the bytes it wrote that it did not run itself (from $0200) */
  written: Range[];
  writtenBytes: number;
  /** the data it read that it had not written itself (from $0200) */
  read: Range[];
  readBytes: number;
  /** written bytes it had read before (in-place work) */
  inPlace: number;
  kind: Kind;
  /** the opcodes of its instructions in address order, as hex: the fingerprint */
  opcodes: string;
}

/** The ranges of addresses where `test` holds; ranges closer than `gap` bytes join. */
export function ranges(test: (a: number) => boolean, gap = 0, from = 0, to = 0xffff): Range[] {
  const out: Range[] = [];
  for (let a = from; a <= to; a++) {
    if (!test(a)) continue;
    const last = out[out.length - 1];
    if (last && a - last.end <= gap + 1) last.end = a;
    else out.push({ start: a, end: a });
  }
  return out;
}

/** What layer `id`, which started at instruction `since`, has done so far. */
export function activity(m: C64, eid: Int32Array, id: number, since: number): Activity {
  const { wid, wtime, rtime, etime, ram } = m;
  const isCode = new Uint8Array(0x10000), isWritten = new Uint8Array(0x10000), isRead = new Uint8Array(0x10000);
  let instructions = 0, writtenBytes = 0, readBytes = 0, inPlace = 0, opcodes = '';
  for (let a = 0; a < 0x10000; a++) {
    if (eid[a] === id) { isCode[a] = 1; instructions++; opcodes += ram[a].toString(16).padStart(2, '0'); }
    if (a < 0x200) continue;
    const ownCode = etime[a] >= since;
    if (wid[a] === id && !(etime[a] > wtime[a])) {
      isWritten[a] = 1; writtenBytes++;
      if (rtime[a] >= since && rtime[a] < wtime[a]) inPlace++;
    }
    if (rtime[a] >= since && !ownCode && !(wid[a] === id && rtime[a] > wtime[a])) { isRead[a] = 1; readBytes++; }
  }
  const kind: Kind = writtenBytes < 16 ? 'jump'
    : writtenBytes > readBytes * 1.25 + 16 ? 'decruncher'
    : inPlace > writtenBytes * 0.6 ? 'decoder'
    : 'mover';
  return {
    code: ranges(a => isCode[a] === 1, 3), instructions,
    written: ranges(a => isWritten[a] === 1, 64), writtenBytes,
    read: ranges(a => isRead[a] === 1, 64), readBytes,
    inPlace, kind, opcodes,
  };
}

// --- text ------------------------------------------------------------------------------------------------------------

/** PETSCII or screen code as a printable character, or '' */
function textChar(b: number, screen: boolean): string {
  if (screen) {
    if (b >= 1 && b <= 26) return String.fromCharCode(0x40 + b);
    if (b >= 0x20 && b < 0x40) return String.fromCharCode(b);
    return '';
  }
  if (b >= 0x20 && b < 0x5b) return String.fromCharCode(b);
  if (b >= 0xc1 && b <= 0xda) return String.fromCharCode(b - 0x80);
  return '';
}

/** mostly letters and spaces (a single word of 8 letters or more), with vowels, not one character over and over */
function looksLikeText(t: string): boolean {
  const letters = t.match(/[A-Z]/g)?.length ?? 0, spaces = t.match(/ /g)?.length ?? 0;
  if (letters < 4 || (letters + spaces) / t.length < 0.7 || (!spaces && t.length < 8)) return false;
  if (/(.)\1{4,}/.test(t.replace(/ /g, ''))) return false;
  return /[AEIOUY]/.test(t);
}

/** Runs of readable text (PETSCII or screen codes) of at least `min` characters, four of them letters. */
export function strings(peek: (a: number) => number, within: Range[], min = 6): string[] {
  const out: string[] = [];
  for (const screen of [false, true]) {
    for (const r of within) {
      let cur = '';
      const flush = () => {
        const t = cur.trim();
        if (t.length >= min && looksLikeText(t)) out.push(t);
        cur = '';
      };
      for (let a = r.start; a <= r.end; a++) {
        const c = textChar(peek(a), screen);
        if (c) cur += c; else flush();
      }
      flush();
    }
  }
  return [...new Set(out)];
}

// --- signatures ------------------------------------------------------------------------------------------------------

/** a known depacker: its name, what kind of layer it is, its fingerprint, and in how many files it was seen */
export interface Signature { name: string; kind?: string; opcodes: string; seen?: number }

export const SIGNATURES: Signature[] = (signatures as { packers: Signature[] }).packers;

function grams(opcodes: string, n = 4): Set<string> {
  const out = new Set<string>();
  const step = 2, len = n * step;
  for (let i = 0; i + len <= opcodes.length; i += step) out.add(opcodes.slice(i, i + len));
  if (!out.size && opcodes) out.add(opcodes);
  return out;
}

const gramCache = new Map<string, Set<string>>();
const cachedGrams = (opcodes: string): Set<string> => {
  let g = gramCache.get(opcodes);
  if (!g) { g = grams(opcodes); if (gramCache.size < 4096) gramCache.set(opcodes, g); }
  return g;
};

/** How alike two fingerprints are, 0..1 (shared 4-instruction sequences over all of them). */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ga = cachedGrams(a), gb = cachedGrams(b);
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return shared / (ga.size + gb.size - shared);
}

/** The best match in the signature list, when it is at least `min` alike. */
export function identify(opcodes: string, list: Signature[] = SIGNATURES, min = 0.8): { name: string; similarity: number } | null {
  if (opcodes.length < 2 * 8) return null;
  let best: { name: string; similarity: number } | null = null;
  for (const sig of list) {
    const s = similarity(opcodes, sig.opcodes);
    if (s >= min && (!best || s > best.similarity)) best = { name: sig.name, similarity: s };
  }
  return best;
}

/** A short, stable id for a fingerprint (FNV-1a), to name an unknown packer by. */
export function fingerprintId(opcodes: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < opcodes.length; i++) { h ^= opcodes.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
