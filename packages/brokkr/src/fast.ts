/* Brokkr's fast format, for decrunching fast: every token is whole bytes, so the decruncher reads no bits, and
 * literals and matches are copied with tight loops.
 *
 * The tokens, in the order the decruncher reads them (data in the order it writes them):
 *  - 000LLLLL: a literal run of L + 1 bytes (1 to 32), which follow.
 *  - 001LOOOO: a match of L + 2 bytes (2 or 3) at offset O + 1 (1 to 16).
 *  - 1LLLOOOO O: a match of L + 2 bytes (2 to 8) at offset O + 1 (1 to 4096; O 12 bits, the token's 4 the high).
 *  - 010LLLLL O O: a match of L + 3 bytes (3 to 33) at offset O + 1 (O 16 bits, high byte first).
 *  - 011LLLLL: a match of L bytes (1 to 30) at the last offset again (the first one's is 1); 0 ends the stream.
 * A full length field (all ones) is followed by a byte e, before the offset: the length is the field's length plus
 * e, at most 255; a longer match goes on as a match at the last offset. */
import { findMatches } from './match.ts';
import { MATCH, type Tokens } from './format.ts';
import { PROFILES, type Effort, type Profile } from './crunch.ts';
import { parseFast } from './parse-fast.ts';

/** the largest offset, and the longest match a token takes */
export const FAST_MAX_OFFSET = 65535, FAST_MAX_LEN = 255;
/** the most literals a token takes */
export const FAST_RUN = 32;

/** A kind of match token: its bits, the length of a length field of 0, the field's full value, the farthest offset,
 * and its bytes (the token's and the offset's). */
export interface FastKind { bits: number; base: number; mask: number; max: number; bytes: number }
export const TINY: FastKind = { bits: 0x20, base: 2, mask: 1, max: 16, bytes: 1 };
export const MID: FastKind = { bits: 0x80, base: 2, mask: 7, max: 4096, bytes: 2 };
export const LONG: FastKind = { bits: 0x40, base: 3, mask: 31, max: 65535, bytes: 3 };
export const REP: FastKind = { bits: 0x60, base: 0, mask: 31, max: 0, bytes: 1 };
const NEW = [TINY, MID, LONG];

/** the bytes a length takes beyond the token's field (Infinity: more than a token takes) */
export const extBytes = (len: number, k: FastKind): number => (len > FAST_MAX_LEN ? Infinity : len - k.base < k.mask ? 0 : 1);

/** what a match costs in bytes: at the last offset, or at a new one (the cheapest kind that takes it; Infinity: none) */
export const repCost = (len: number): number => 1 + extBytes(len, REP);
export const newCost = (len: number, o: number): number => {
  let c = Infinity;
  for (const k of NEW) if (o <= k.max && len >= k.base) c = Math.min(c, k.bytes + extBytes(len, k));
  return c;
};

class Writer {
  readonly bytes: number[] = [];
  byte(v: number): void { this.bytes.push(v & 0xff); }
  /** a match token (with `high` in its offset bits), and the length's bytes after it */
  token(k: FastKind, len: number, high = 0): void {
    const f = len - k.base, shift = k === REP || k === LONG ? 0 : 4;
    if (f < k.mask) { this.byte(k.bits | (f << shift) | high); return; }
    this.byte(k.bits | (k.mask << shift) | high);
    this.byte(f - k.mask);
  }
}

/** The stream of a parse, in reading order. Consecutive literal tokens are one run (in tokens of up to 32); a match
 * longer than 255 bytes goes on as matches at the last offset. */
export function writeFast(d: Uint8Array, t: Tokens): Uint8Array {
  const w = new Writer();
  let pos = 0, last = 1;
  for (let i = 0; i < t.count;) {
    if (t.kind[i] !== MATCH) {
      let len = 0;
      while (i < t.count && t.kind[i] !== MATCH) len += t.len[i++];
      for (let k = 0; k < len; k += FAST_RUN) {
        const n = Math.min(FAST_RUN, len - k);
        w.byte(n - 1);
        for (let j = 0; j < n; j++) w.byte(d[pos + k + j]);
      }
      pos += len;
    } else {
      const all = t.len[i], o = t.off[i++];
      if (o < 1 || o > FAST_MAX_OFFSET || o > pos || all < 1) throw new Error(`A match of ${all} bytes at offset ${o} at byte ${pos} in a parse for the fast format.`);
      for (let done = 0; done < all;) {
      const len = Math.min(FAST_MAX_LEN, all - done);
      const fresh = newCost(len, o);
      if (o === last && repCost(len) <= fresh) w.token(REP, len);
      else {
        const k = NEW.find(x => o <= x.max && len >= x.base && x.bytes + extBytes(len, x) === fresh);
        if (!k) throw new Error(`A match of ${len} bytes at offset ${o} in a parse for the fast format.`);
        if (k === LONG) { w.token(k, len); w.byte((o - 1) >> 8); w.byte(o - 1); }
        else if (k === MID) { w.token(k, len, (o - 1) >> 8); w.byte(o - 1); }
        else w.token(k, len, o - 1);
      }
      done += len;
      last = o;
      }
      pos += all;
    }
  }
  w.byte(REP.bits);
  return Uint8Array.from(w.bytes);
}

export class FastError extends Error {}

export interface FastDecoded {
  data: Uint8Array;
  /** stream bytes unread less data bytes still to come, at worst over the writes: the in-place margin */
  safety: number;
  tokens: { literals: number; runs: number; matches: number; reps: number };
}

/** Decrunch a stream (in reading order), reading as the 6502 decruncher does. */
export function readFast(s: Uint8Array, maxOut = 1 << 24): FastDecoded {
  let at = 0;
  const out: number[] = [], unreadAt: number[] = [];
  const tokens = { literals: 0, runs: 0, matches: 0, reps: 0 };
  const byte = () => {
    if (at >= s.length) throw new FastError(`The stream ends after ${s.length} bytes, in the middle of a token.`);
    return s[at++];
  };
  const put = (v: number) => {
    out.push(v); unreadAt.push(s.length - at);
    if (out.length > maxOut) throw new FastError(`The stream decrunches to more than ${maxOut} bytes.`);
  };
  const length = (f: number, k: FastKind) => {
    if (f < k.mask) return f + k.base;
    const v = k.mask + k.base + byte();
    if (v > 255) throw new FastError(`A length of ${v}.`);
    return v;
  };
  let last = 1;
  for (;;) {
    const t = byte();
    let len: number;
    if (t & 0x80) { len = length((t >> 4) & 7, MID); last = (((t & 15) << 8) | byte()) + 1; tokens.matches++; }
    else if (t < 0x20) {
      const n = t + 1;
      for (let k = 0; k < n; k++) put(byte());
      tokens.literals += n; tokens.runs++;
      continue;
    } else if (t < 0x40) { len = length((t >> 4) & 1, TINY); last = (t & 15) + 1; tokens.matches++; }
    else if (t < 0x60) { len = length(t & 31, LONG); last = ((byte() << 8) | byte()) + 1; tokens.matches++; }
    else {
      if (t === REP.bits) break;
      len = length(t & 31, REP); tokens.reps++;
    }
    if (!len) throw new FastError('A match of no bytes.');
    if (last > out.length) throw new FastError(`A match at byte ${out.length} reaches ${last} bytes back, before the start.`);
    for (let k = 0; k < len; k++) put(out[out.length - last]);
  }
  const total = out.length;
  let safety = 0;
  for (let i = 0; i < total; i++) safety = Math.max(safety, unreadAt[i] - (total - 1 - i));
  return { data: Uint8Array.from(out), safety, tokens };
}

export interface FastOptions { effort?: Effort; profile?: Partial<Profile> }

export interface FastCrunched {
  /** the stream in reading order */
  stream: Uint8Array;
  tokens: Tokens;
  /** stream bytes unread less data bytes to come, at worst: the in-place margin */
  safety: number;
  stats: { literals: number; runs: number; matches: number; reps: number };
  ms: number;
}

/** Crunch to the fast format (data in the order it is decrunched), and check that the stream decrunches to it. */
export function crunchFast(d: Uint8Array, o: FastOptions = {}): FastCrunched {
  const t0 = performance.now();
  if (!d.length) throw new Error('There is nothing to crunch: the data is empty.');
  const prof = { ...PROFILES[o.effort ?? 'normal'], ...o.profile };
  const m = findMatches(d, { maxLen: 65535, maxOffset: FAST_MAX_OFFSET, nice: prof.nice, depth: prof.depth });
  const { tokens } = parseFast(d, m, { arrivals: prof.arrivals, allLens: prof.allLens });
  const stream = writeFast(d, tokens);
  const back = readFast(stream);
  if (back.data.length !== d.length || back.data.some((b, i) => b !== d[i])) {
    throw new Error("Brokkr's own check failed: its fast format's stream does not decrunch to the data. This is a bug in Brokkr; please report it with the file.");
  }
  return { stream, tokens, safety: back.safety, stats: back.tokens, ms: performance.now() - t0 };
}
