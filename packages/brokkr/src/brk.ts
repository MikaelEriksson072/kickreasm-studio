/* Brokkr's own stream format, for packing as small as it gets: LZ tokens coded with a binary arithmetic coder whose
 * probabilities adapt after every bit, as LZMA's do, kept simple enough for a 6502 to decode.
 *
 * The coder: a 16-bit range kept from $8000 up, 8-bit probabilities (of a 0, in 256ths) that move about a
 * sixteenth of the way after each bit (p - p / 16 after a 1, p + (255 - p) / 16 after a 0), and bound =
 * (range >> 8) * probability. Bits are renormalised one at a time, so the stream is a plain bit string, read from
 * the top of each byte; it starts with the decoder's first 16 bits, and the decoder takes in the next ones just
 * before the bit that needs them.
 *
 * The tokens, each made of adaptive bits:
 *  - is it a match? (in the context of whether the token before was a literal or a match)
 *  - a literal: its 8 bits down a binary tree of 255 probabilities
 *  - after a literal, does the match take the last match's offset again (a rep)? (the first one's is 1)
 *  - a length: for each bit after its top one a 1 and the bit, then a 0 (contexts by step; reps have their own)
 *  - an offset: its bit length (its slot) down a 5-bit tree in the context of the length (1, 2 or more), then the
 *    bits below the top one from the top: the first 4 in the context of the slot and their place, then the bits
 *    in the context of their place (offsets that are multiples of 2, 8 or 16 get cheap). Slot 0 ends the stream.
 * The probabilities are 499 bytes: page 0 the literal tree, page 1 the rest. */
import { MATCH, type Tokens } from './format.ts';

export const PROBS = 512;
/** the contexts of page 1 */
export const IS_MATCH = 256, IS_REP = 258, LEN = 260, REP_LEN = 292, SLOT = 324, OFF_T = 420, LOW = 488;
const SHIFT = 4;

/** the offset's bit length (its slot): 1 for 1, 16 for $8000 and up */
export const slotOf = (o: number): number => 32 - Math.clz32(o);
/** the slot tree's context set for a length: 1, 2, or more */
export const lenClass = (len: number): number => (len >= 3 ? 2 : len - 1);
/** the context of the bit at place j of an offset of slot s: the first 4 below the top one by the slot, the others
 * by their place */
export const offsetCtx = (s: number, j: number): number => (s - 2 - j < 4 ? OFF_T + s * 4 + (s - 2 - j) : LOW + j);

// --- the coder ----------------------------------------------------------------------------------------------------

export class Encoder {
  private low = 0;
  private range = 0xffff;
  readonly bits: number[] = [];
  readonly p = new Uint8Array(PROBS).fill(128);

  private carry(): void {
    let i = this.bits.length - 1;
    while (i >= 0 && this.bits[i] === 1) this.bits[i--] = 0;
    if (i < 0) throw new Error('the arithmetic coder carried past the start of the stream');
    this.bits[i] = 1;
  }

  private renorm(): void {
    if (this.low >= 0x10000) { this.carry(); this.low -= 0x10000; }
    while (this.range < 0x8000) {
      this.bits.push((this.low >> 15) & 1);
      this.low = (this.low << 1) & 0xffff;
      this.range <<= 1;
    }
  }

  bit(ctx: number, b: number): void {
    const p = this.p[ctx], bound = (this.range >> 8) * p;
    if (b) { this.low += bound; this.range -= bound; this.p[ctx] = p - (p >> SHIFT); }
    else { this.range = bound; this.p[ctx] = p + ((255 - p) >> SHIFT); }
    this.renorm();
  }

  /** a value down a binary tree of `n` bits, its nodes from ctx + 1 */
  tree(ctx: number, n: number, v: number): void {
    let node = 1;
    for (let i = n - 1; i >= 0; i--) { const b = (v >> i) & 1; this.bit(ctx + node, b); node = (node << 1) | b; }
  }

  /** the stream, bytes in reading order: the bits from the top of each byte */
  finish(): Uint8Array {
    let v = this.low + (this.range >> 1);
    if (v >= 0x10000) { this.carry(); v -= 0x10000; }
    for (let i = 15; i >= 0; i--) this.bits.push((v >> i) & 1);
    const out = new Uint8Array((this.bits.length + 7) >> 3);
    this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
    return out;
  }
}

export class Decoder {
  private range = 0xffff;
  private code = 0;
  private bit_ = 0;
  readonly p = new Uint8Array(PROBS).fill(128);
  private readonly s: Uint8Array;
  constructor(s: Uint8Array) {
    this.s = s;
    for (let i = 0; i < 16; i++) this.code = (this.code << 1) | this.next();
  }
  /** stream bytes started so far */
  get read(): number { return (this.bit_ + 7) >> 3; }
  private next(): number {
    const i = this.bit_++;
    if ((i >> 3) >= this.s.length) throw new Error(`The stream ends after ${this.s.length} bytes, in the middle of a token.`);
    return (this.s[i >> 3] >> (7 - (i & 7))) & 1;
  }
  /** a bit: first the stream's bits the range needs (as the 6502 takes them, for the safety margin) */
  bit(ctx: number): number {
    while (this.range < 0x8000) { this.range <<= 1; this.code = (this.code << 1) | this.next(); }
    const p = this.p[ctx], bound = (this.range >> 8) * p;
    let b: number;
    if (this.code < bound) { this.range = bound; this.p[ctx] = p + ((255 - p) >> SHIFT); b = 0; }
    else { this.code -= bound; this.range -= bound; this.p[ctx] = p - (p >> SHIFT); b = 1; }
    return b;
  }
  tree(ctx: number, n: number): number {
    let node = 1;
    for (let i = 0; i < n; i++) node = (node << 1) | this.bit(ctx + node);
    return node - (1 << n);
  }
}

// --- the tokens ------------------------------------------------------------------------------------------------

/** What codes tokens: the encoder, or a counter of bits and contexts. */
export interface Coder { bit(ctx: number, b: number): void; tree(ctx: number, n: number, v: number): void }

function gamma(c: Coder, u: number, v: number): void {
  const n = 31 - Math.clz32(v);
  for (let i = 0; i < n; i++) { c.bit(u + 2 * i, 1); c.bit(u + 2 * i + 1, (v >> (n - 1 - i)) & 1); }
  c.bit(u + 2 * n, 0);
}

function offset(c: Coder, len: number, o: number): void {
  const s = slotOf(o);
  c.tree(SLOT + lenClass(len) * 32, 5, s);
  for (let j = s - 2; j >= 0; j--) c.bit(offsetCtx(s, j), (o >> j) & 1);
}

/**
 * Code a parse. A match right after a literal that takes the last match's offset again is a rep (none before the
 * first match). The data is in the order it is decrunched; literal tokens of any length are literals one by one.
 */
export function codeTokens(c: Coder, d: Uint8Array, t: Tokens): void {
  let pos = 0, prevMatch = 0, last = 1;
  for (let i = 0; i < t.count; i++) {
    const len = t.len[i];
    if (t.kind[i] === MATCH) {
      c.bit(IS_MATCH + prevMatch, 1);
      const o = t.off[i];
      if (!prevMatch) {
        const rep = o === last ? 1 : 0;
        c.bit(IS_REP, rep);
        if (rep) gamma(c, REP_LEN, len);
        else { gamma(c, LEN, len); offset(c, len, o); }
      } else { gamma(c, LEN, len); offset(c, len, o); }
      last = o;
      prevMatch = 1;
    } else {
      for (let k = 0; k < len; k++) {
        c.bit(IS_MATCH + (k === 0 ? prevMatch : 0), 0);
        c.tree(0, 8, d[pos + k]);
      }
      prevMatch = 0;
    }
    pos += len;
  }
  c.bit(IS_MATCH + prevMatch, 1);
  if (!prevMatch) c.bit(IS_REP, 0);
  gamma(c, LEN, 1);
  c.tree(SLOT + lenClass(1) * 32, 5, 0);
}

/** The stream of a parse, in reading order. */
export function writeBrk(d: Uint8Array, t: Tokens): Uint8Array {
  const e = new Encoder();
  codeTokens(e, d, t);
  return e.finish();
}

export interface BrkDecoded {
  data: Uint8Array;
  /** stream bytes unread less data bytes still to come, at worst over the writes: the in-place margin */
  safety: number;
  tokens: { literals: number; matches: number; reps: number };
}

export class BrkError extends Error {}

/** Decrunch a stream (in reading order). */
export function readBrk(s: Uint8Array, maxOut = 1 << 24): BrkDecoded {
  const dec = new Decoder(s);
  const out: number[] = [], unreadAt: number[] = [];
  const tokens = { literals: 0, matches: 0, reps: 0 };
  const put = (v: number) => {
    out.push(v); unreadAt.push(s.length - dec.read);
    if (out.length > maxOut) throw new BrkError(`The stream decrunches to more than ${maxOut} bytes.`);
  };
  const gam = (u: number) => {
    let v = 1;
    for (let i = 0; dec.bit(u + 2 * i); i++) {
      if (i === 15) throw new BrkError('A length has more than 16 bits.');
      v = (v << 1) | dec.bit(u + 2 * i + 1);
    }
    return v;
  };
  let prevMatch = 0, last = 1;
  for (;;) {
    if (!dec.bit(IS_MATCH + prevMatch)) { put(dec.tree(0, 8)); tokens.literals++; prevMatch = 0; continue; }
    let len: number, o: number;
    if (!prevMatch && dec.bit(IS_REP)) { len = gam(REP_LEN); o = last; tokens.reps++; }
    else {
      len = gam(LEN);
      const sl = dec.tree(SLOT + lenClass(len) * 32, 5);
      if (sl === 0) break;
      if (sl > 16) throw new BrkError(`An offset of ${sl} bits.`);
      o = 1;
      for (let j = sl - 2; j >= 0; j--) o = (o << 1) | dec.bit(offsetCtx(sl, j));
    }
    if (o > out.length) throw new BrkError(`A match at byte ${out.length} reaches ${o} bytes back, before the start.`);
    for (let k = 0; k < len; k++) put(out[out.length - o]);
    tokens.matches++;
    last = o;
    prevMatch = 1;
  }
  const total = out.length;
  let safety = 0;
  for (let i = 0; i < total; i++) safety = Math.max(safety, unreadAt[i] - (total - 1 - i));
  return { data: Uint8Array.from(out), safety, tokens };
}

// --- prices for the parse ----------------------------------------------------------------------------------------

/** Prices are in 1/32 bit. */
export const UNIT = 32;
const priceOf = (p: number, b: number) => Math.round(-Math.log2((b ? 256 - p : p) / 256) * UNIT);
const SHORT = 4096;

/** What tokens cost with given probabilities, as the parse looks them up. */
export interface BrkPrices {
  /** a literal byte after a literal and after a match, the is-match bit included */
  litAfterLit: Int32Array; litAfterMatch: Int32Array;
  /** the bits before a match's length: after a literal (is-match, not a rep), after a match (is-match), a rep */
  matchAfterLit: number; matchAfterMatch: number; rep: number;
  /** lengths up to 4096 (longer ones: lenPrice) */
  len: Int32Array; repLen: Int32Array;
  /** the parts of an offset's price (offPrice) */
  slot: Int32Array; top: Int32Array; low: Int32Array;
  /** for lengths over 4096: the unary part and each bit's price, 0 and 1 */
  lenParts: Int32Array; repParts: Int32Array;
  /** the end token, once */
  end: number;
}

export function offPrice(pr: BrkPrices, cls: number, o: number): number {
  const s = slotOf(o);
  let x = pr.slot[cls * 17 + s];
  for (let j = s - 2; j >= 0; j--) {
    const k = s - 2 - j, b = (o >> j) & 1;
    x += k < 4 ? pr.top[(s * 4 + k) * 2 + b] : pr.low[j * 2 + b];
  }
  return x;
}

function longLen(parts: Int32Array, v: number): number {
  const n = 31 - Math.clz32(v);
  let s = parts[16 + n];
  for (let i = 0; i < n; i++) s += parts[i] + parts[32 + i * 2 + ((v >> (n - 1 - i)) & 1)];
  return s;
}
export const lenPrice = (pr: BrkPrices, l: number): number => (l <= SHORT ? pr.len[l] : longLen(pr.lenParts, l));
export const repLenPrice = (pr: BrkPrices, l: number): number => (l <= SHORT ? pr.repLen[l] : longLen(pr.repParts, l));

/** The prices of tokens when each context's probability of a 0 is p0(ctx). */
export function prices(p0: (ctx: number) => number): BrkPrices {
  const pb = (ctx: number, b: number) => priceOf(p0(ctx), b);
  const treePrice = (ctx: number, n: number, v: number) => {
    let node = 1, s = 0;
    for (let i = n - 1; i >= 0; i--) { const b = (v >> i) & 1; s += pb(ctx + node, b); node = (node << 1) | b; }
    return s;
  };
  const lit = new Int32Array(256);
  for (let v = 0; v < 256; v++) lit[v] = treePrice(0, 8, v);
  const litAfterLit = lit.map(x => x + pb(IS_MATCH, 0)), litAfterMatch = lit.map(x => x + pb(IS_MATCH + 1, 0));
  // parts: [0..15] step i's 1 (one more bit), [16..31] its 0 (the end), [32..] step i's bit, 0 and 1
  const gammaParts = (u: number) => {
    const parts = new Int32Array(64);
    for (let i = 0; i < 16; i++) {
      parts[i] = pb(u + 2 * i, 1); parts[16 + i] = pb(u + 2 * i, 0);
      parts[32 + i * 2] = pb(u + 2 * i + 1, 0); parts[32 + i * 2 + 1] = pb(u + 2 * i + 1, 1);
    }
    return parts;
  };
  const gammaTable = (parts: Int32Array) => {
    const out = new Int32Array(SHORT + 1);
    for (let v = 1; v <= SHORT; v++) out[v] = longLen(parts, v);
    return out;
  };
  const slot = new Int32Array(3 * 17);
  for (let cls = 0; cls < 3; cls++) for (let s = 0; s < 17; s++) slot[cls * 17 + s] = treePrice(SLOT + cls * 32, 5, s);
  const top = new Int32Array(17 * 4 * 2);
  for (let i = 0; i < 17 * 4; i++) { top[i * 2] = pb(OFF_T + i, 0); top[i * 2 + 1] = pb(OFF_T + i, 1); }
  const low = new Int32Array(32);
  for (let j = 0; j < 16; j++) { low[j * 2] = pb(LOW + j, 0); low[j * 2 + 1] = pb(LOW + j, 1); }
  const lenParts = gammaParts(LEN), repParts = gammaParts(REP_LEN);
  const len = gammaTable(lenParts);
  return {
    litAfterLit, litAfterMatch,
    matchAfterLit: pb(IS_MATCH, 1) + pb(IS_REP, 0), matchAfterMatch: pb(IS_MATCH + 1, 1), rep: pb(IS_MATCH, 1) + pb(IS_REP, 1),
    len, repLen: gammaTable(repParts), slot, top, low, lenParts, repParts,
    end: pb(IS_MATCH, 1) + len[1] + slot[0],
  };
}

/** Counts 0s and 1s per context, and the bits the coder spends. */
export class Counter implements Coder {
  readonly n0 = new Float64Array(PROBS);
  readonly n1 = new Float64Array(PROBS);
  bits = 0;
  private readonly p = new Uint8Array(PROBS).fill(128);
  bit(ctx: number, b: number): void {
    const p = this.p[ctx];
    this.bits += -Math.log2((b ? 256 - p : p) / 256);
    this.p[ctx] = b ? p - (p >> SHIFT) : p + ((255 - p) >> SHIFT);
    if (b) this.n1[ctx]++; else this.n0[ctx]++;
  }
  tree(ctx: number, n: number, v: number): void {
    let node = 1;
    for (let i = n - 1; i >= 0; i--) { const b = (v >> i) & 1; this.bit(ctx + node, b); node = (node << 1) | b; }
  }
}

/** Prices from a parse's counts: each context's average over the file. */
export function pricesFrom(c: Counter | null): BrkPrices {
  return prices(ctx => {
    if (!c) return 128;
    const a = c.n0[ctx] + 0.4, b = c.n1[ctx] + 0.4;
    return Math.min(240, Math.max(15, Math.round(256 * a / (a + b))));
  });
}

/** The adaptive bits a parse codes to, and the counts per context. */
export function countTokens(d: Uint8Array, t: Tokens): Counter {
  const c = new Counter();
  codeTokens(c, d, t);
  return c;
}

/**
 * Prices block by block from what the parse's tokens coded in each block of `1 << shift` bytes, drawn towards the
 * file's average by `weight` decisions' worth: the parse after it pays about what the coder charges there.
 */
export function blockAverages(d: Uint8Array, t: Tokens, shift: number, weight = 16): BrkPrices[] {
  const blocks = (d.length >> shift) + 1;
  const n0 = Array.from({ length: blocks }, () => new Float64Array(PROBS)), n1 = Array.from({ length: blocks }, () => new Float64Array(PROBS));
  const file = new Counter();
  let block = 0;
  const counter: Coder = {
    bit(ctx, b) { (b ? n1 : n0)[block][ctx]++; file.bit(ctx, b); },
    tree(ctx, n, v) { let node = 1; for (let i = n - 1; i >= 0; i--) { const b = (v >> i) & 1; this.bit(ctx + node, b); node = (node << 1) | b; } },
  };
  let pos = 0;
  // each token counts in the block it starts in
  let prevMatch = 0, last = 1;
  for (let i = 0; i < t.count; i++) {
    block = Math.min(blocks - 1, pos >> shift);
    const len = t.len[i];
    if (t.kind[i] === MATCH) {
      counter.bit(IS_MATCH + prevMatch, 1);
      const o = t.off[i];
      if (!prevMatch) {
        const rep = o === last ? 1 : 0;
        counter.bit(IS_REP, rep);
        if (rep) gamma(counter, REP_LEN, len); else { gamma(counter, LEN, len); offset(counter, len, o); }
      } else { gamma(counter, LEN, len); offset(counter, len, o); }
      last = o; prevMatch = 1;
    } else {
      for (let k = 0; k < len; k++) { counter.bit(IS_MATCH + (k === 0 ? prevMatch : 0), 0); counter.tree(0, 8, d[pos + k]); }
      prevMatch = 0;
    }
    pos += len;
  }
  return n0.map((b0, i) => prices(ctx => {
    const f0 = (file.n0[ctx] + 0.4) / (file.n0[ctx] + file.n1[ctx] + 0.8);
    const p = (b0[ctx] + weight * f0) / (b0[ctx] + n1[i][ctx] + weight);
    return Math.min(240, Math.max(15, Math.round(256 * p)));
  }));
}
