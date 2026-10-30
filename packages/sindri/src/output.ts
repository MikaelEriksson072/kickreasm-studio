/* Which bytes in memory belong to the unpacked program, when a layer starts, and the PRG that holds them.
 *
 * A byte belongs to it when the layer that handed over (the producer) wrote it and did not run it, except:
 * - below $0400, a write it read back (its own variable);
 * - packed data it moved and then consumed: a long stretch it read back that is one copy of memory as it was when
 *   the producer started, moved by a single distance, and the unread end of it. (Output it reads back, as an LZ
 *   decruncher does, is new data; its literal bytes are copies too, but short ones, between the matches.)
 *
 * Older bytes (from the loaded file, or written by an earlier layer) belong to it when no depacker read or ran them,
 * unless they are the rest of a block the depackers used: the stub's leftovers around its code, the end of a copy of
 * packed data that was never read. A large untouched stretch of the loaded file, or of what an earlier depacker
 * unpacked, stays even then; of a block a mover copied, nothing does. */
import { BOOT, LOADED, type C64 } from './c64.ts';
import type { Kind, Range } from './analyze.ts';

/** an untouched stretch this long belongs to the program even inside a block the depackers used */
const LARGE = 0x200;
/** bytes per window when looking for a stretch in the memory before */
const WINDOW = 6;
/** a moved block of packed data is at least this long */
const MOVED = 0x100;

/** 1 for every address whose byte belongs to the program a layer starts, when `producer` handed over;
 * `before` is memory as it was when the producer started, `kinds` what the earlier layers were. */
export function contentMask(m: C64, producer: number, before: Uint8Array, kinds: Map<number, Kind> = new Map()): Uint8Array {
  const { wid, wtime, rtime, etime, ram } = m;
  const mask = new Uint8Array(0x10000);
  const ran = (a: number) => etime[a] > wtime[a];
  const used = (a: number) => ran(a) || rtime[a] > wtime[a];
  let windows: Map<number, number[]> | null = null;
  /** whether ram[p..q) is a copy of a stretch of the memory before, moved by one distance (95% of its bytes) */
  const copied = (p: number, q: number): boolean => {
    // packed data has its byte values spread out; text or graphics with one value in a third of it is not that
    const count = new Uint32Array(256);
    for (let t = p; t < q; t++) count[ram[t]]++;
    if (Math.max(...count) * 3 > q - p) return false;
    windows ??= windowsOf(before);
    let k = p;
    while (k + WINDOW <= q && windowAt(ram, k) < 0) k++;
    if (k + WINDOW > q) return false;
    for (const from of windows.get(windowAt(ram, k)) ?? []) {
      const d = from - k;
      let same = 0;
      for (let t = p; t < q; t++) if (ram[t] === before[(t + d) & 0xffff]) same++;
      if (same >= (q - p) * 0.95) return true;
    }
    return false;
  };
  let a = 0;
  while (a < 0x10000) {
    const w = wid[a];
    let end = a;
    while (end < 0x10000 && wid[end] === w) end++;
    if (w === BOOT) { a = end; continue; }
    if (w === producer) {
      // keep what it wrote and did not run, then take out consumed copies and their unread ends
      for (let p = a; p < end; p++) if (!ran(p) && !(p < 0x400 && rtime[p] > wtime[p])) mask[p] = 1;
      for (let p = a; p < end;) {
        if (!(rtime[p] > wtime[p]) || ran(p)) { p++; continue; }
        let q = p;
        while (q < end && rtime[q] > wtime[q] && !ran(q)) q++;
        if (q - p >= MOVED && copied(p, q)) {
          mask.fill(0, p, q);
          for (const dir of [-1, 1]) {
            let r = dir < 0 ? p - 1 : q, n = 0;
            while (r >= a && r < end && !used(r) && n < LARGE) { r += dir; n++; }
            if (n < LARGE) for (let t = dir < 0 ? p - 1 : q; t !== r; t += dir) mask[t] = 0;
          }
        }
        p = q;
      }
    } else {
      // a block written by one older layer (or loaded): keep its untouched stretches unless the depackers used it
      let any = false;
      for (let p = a; p < end; p++) if (used(p)) { any = true; break; }
      const large = w === LOADED || kinds.get(w) === 'decruncher' || kinds.get(w) === 'decoder' ? LARGE : 0x10000;
      for (let p = a; p < end;) {
        if (used(p)) { p++; continue; }
        let q = p;
        while (q < end && !used(q)) q++;
        if (!any || q - p >= large) mask.fill(1, p, q);
        p = q;
      }
    }
    a = end;
  }
  return mask;
}

/** the WINDOW bytes at k as one number, or -1 when they are all the same */
function windowAt(mem: Uint8Array, k: number): number {
  let key = 0, same = true;
  for (let i = WINDOW - 1; i >= 0; i--) {
    const b = mem[(k + i) & 0xffff];
    if (b !== mem[k]) same = false;
    key = key * 256 + b;
  }
  return same ? -1 : key;
}

/** where each window occurs (the first 8 places) */
function windowsOf(mem: Uint8Array): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (let k = 0; k + WINDOW <= 0x10000; k++) {
    const key = windowAt(mem, k);
    if (key < 0) continue;
    const at = map.get(key);
    if (!at) map.set(key, [k]); else if (at.length < 8) at.push(k);
  }
  return map;
}

/** gap between two parts of a program that still counts as one part */
const JOIN = 0x100;
/** a part smaller than this is dropped (a depacker's variables, a status line it printed) */
const SMALL = 0x80;

/**
 * The range to save: the program's parts from $0200 up, without small parts far from the rest. A part holding
 * `keep` (the entry, or $0801 for BASIC) always stays. Null when nothing belongs to the program.
 */
export function saveRange(mask: Uint8Array, keep: number[]): Range | null {
  const parts: (Range & { bytes: number })[] = [];
  for (let a = 0x200; a < 0x10000; a++) {
    if (!mask[a]) continue;
    const last = parts[parts.length - 1];
    if (last && a - last.end <= JOIN) { last.end = a; last.bytes++; }
    else parts.push({ start: a, end: a, bytes: 1 });
  }
  if (!parts.length) return null;
  const kept = parts.filter(p => p.bytes >= SMALL || keep.some(k => k >= p.start && k <= p.end));
  const use = kept.length ? kept : parts;
  return { start: Math.min(...use.map(p => p.start)), end: Math.max(...use.map(p => p.end)) };
}

/** The PRG of `start`..`end` (load address first); with `clean`, bytes not in the mask become 0. */
export function buildPrg(ram: Uint8Array, range: Range, mask?: Uint8Array): Uint8Array {
  const out = new Uint8Array(range.end - range.start + 3);
  out[0] = range.start & 0xff;
  out[1] = range.start >> 8;
  out.set(ram.subarray(range.start, range.end + 1), 2);
  if (mask) for (let a = range.start; a <= range.end; a++) if (!mask[a]) out[a - range.start + 2] = 0;
  return out;
}
