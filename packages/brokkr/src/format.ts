/* The Exomizer 3.1 bit stream, as Exomizer's own decrunchers read it: the -P protocol bits, the -T traits, the
 * encoding (the bucket tables in the stream's header), what each token costs, writing a token list as a stream,
 * and a decoder for every protocol, which Brokkr checks each stream with.
 *
 * Everything here works on the stream in the order the decruncher reads it, and on the data in the order it is
 * written: for a backward decruncher (Exomizer's mem and sfx) that is the data reversed, and the file holds the
 * stream reversed. */

/** -P: the protocol bits. 39 (BE, COPY_GT7, IMPL_LIT, REUSE) is Exomizer 3.1's default. */
export const P = {
  /** bits are read from the top of the bit buffer (rol); 0: from the bottom (ror, Exomizer 2) */
  BE: 1,
  /** more than 7 bits: the rest of a byte from the bit buffer, then whole bytes */
  COPY_GT7: 2,
  /** the first literal byte has no flag bit */
  IMPL_LIT: 4,
  /** the stream starts on a whole bit buffer byte, with no marker bit */
  ALIGN: 8,
  /** a table of its own for the offsets of length 3 */
  FOUR_TABLES: 16,
  /** after one literal (or literal sequence) that follows a match, a bit says whether its offset is used again */
  REUSE: 32,
} as const;
export const DEFAULT_PROTOCOL = 39;

/** -T: traits the decruncher can do without. Exomizer's mem and level use 4, raw 0. */
export const T = {
  /** no literal sequences */
  NO_LIT_SEQ: 1,
  /** no matches of length 1 */
  NO_LEN1: 2,
  /** no lengths 256 m + n with m > 0 and n below 3 (4 with FOUR_TABLES), which exodecrunch.s gets wrong */
  NO_MIRRORS: 4,
} as const;

export interface Protocol {
  /** -P bits */
  flags: number;
  /** -T bits */
  traits: number;
  /** -M: the longest match or literal sequence (at most 65535) */
  maxLen: number;
  /** -m: the largest offset (at most 65535) */
  maxOffset: number;
}

export const protocol = (p: Partial<Protocol> = {}): Protocol =>
  ({ flags: DEFAULT_PROTOCOL, traits: 0, maxLen: 65535, maxOffset: 65535, ...p });

/** The bits per bucket of the length table and of each offset table: [length 1, length 2, (length 3,) longer]. */
export interface Encoding { len: number[]; off: number[][] }

export const tableCount = (flags: number): number => (flags & P.FOUR_TABLES ? 4 : 3);
/** the bucket count of offset table t: 4 for length 1, else 16 */
export const tableSize = (t: number): number => (t === 0 ? 4 : 16);
/** the bits of the bucket index of offset table t */
export const TABLE_BITS = [2, 4, 4, 4];
/** the offset table of a match of this length */
export const tableOf = (len: number, flags: number): number =>
  len === 1 ? 0 : len === 2 ? 1 : flags & P.FOUR_TABLES ? (len === 3 ? 2 : 3) : 2;

export const headerBits = (flags: number): number => 4 * (16 + (tableCount(flags) === 4 ? 52 : 36));

/** The first value of each bucket: 1, then each one after the one before. */
export function bases(bits: readonly number[]): number[] {
  const out: number[] = [];
  let a = 1;
  for (let i = 0; i < bits.length; i++) { out.push(a); a += 1 << bits[i]; }
  return out;
}

/** The encoding as Exomizer prints it ("Enc:" and -e): hex digits, the length table first. */
export function encodingText(e: Encoding): string {
  const hex = (bs: readonly number[]) => bs.map(b => b.toString(16).toUpperCase()).join('');
  return [hex(e.len), ...e.off.map(hex)].join(',');
}

export function parseEncoding(text: string, flags: number): Encoding {
  const parts = text.trim().split(',');
  const n = tableCount(flags);
  if (parts.length !== n + 1) throw new Error(`An encoding has ${n + 1} tables separated by commas, not ${parts.length}.`);
  const sizes = [16, ...Array.from({ length: n }, (_, t) => tableSize(t))];
  const tables = parts.map((p, i) => {
    if (!/^[0-9a-f]*$/i.test(p) || p.length > sizes[i]) throw new Error(`Table ${i + 1} of the encoding, "${p}", is not up to ${sizes[i]} hex digits.`);
    return Array.from({ length: sizes[i] }, (_, k) => (k < p.length ? parseInt(p[k], 16) : 0));
  });
  return { len: tables[0], off: tables.slice(1) };
}

// --- costs ------------------------------------------------------------------------------------------------------

export const INF = 0x3fffffff;
export const LITERAL_BITS = 9;
/** a literal sequence: the flag, gamma code 17 and 16 bits of length, then the bytes */
export const SEQ_BITS = 1 + 18 + 16;
/** the end: the flag and gamma code 16 */
export const END_BITS = 1 + 17;

/** What each length and offset costs in bits with an encoding (INF where it cannot be written). */
export interface Costs {
  /** the gamma-coded bucket and the bits within it (no flag bit) */
  len: Int32Array;
  /** per offset table: the bucket index and the bits within it */
  off: Int32Array[];
}

export function costs(e: Encoding, p: Protocol): Costs {
  const len = new Int32Array(65536).fill(INF);
  let base = 1;
  for (let g = 0; g < 16; g++) {
    const end = Math.min(65536, base + (1 << e.len[g]));
    for (let l = base; l < end && l <= p.maxLen; l++) len[l] = g + 1 + e.len[g];
    base = end;
    if (base >= 65536) break;
  }
  if (p.traits & T.NO_MIRRORS) {
    const below = p.flags & P.FOUR_TABLES ? 4 : 3;
    for (let l = 256; l < 65536; l += 256) for (let k = 0; k < below; k++) len[l + k] = INF;
  }
  const off = e.off.map((bits, t) => {
    const c = new Int32Array(65536).fill(INF);
    let b = 1;
    for (let i = 0; i < bits.length; i++) {
      const end = Math.min(65536, b + (1 << bits[i]));
      for (let o = b; o < end && o <= p.maxOffset; o++) c[o] = TABLE_BITS[t] + bits[i];
      b = end;
      if (b >= 65536) break;
    }
    return c;
  });
  if (p.traits & T.NO_LEN1) off[0].fill(INF);
  return { len, off };
}

// --- tokens -------------------------------------------------------------------------------------------------------

export const LIT = 0, SEQ = 1, MATCH = 2;
/** A parse: tokens in the order they are decrunched. A literal or sequence takes its bytes from the data at its place. */
export interface Tokens {
  kind: Uint8Array;
  len: Int32Array;
  off: Int32Array;
  count: number;
}

/** Whether each match takes the offset again (it can, so it does: a reuse costs no offset bits). */
export function reuses(t: Tokens, flags: number): Uint8Array {
  const out = new Uint8Array(t.count);
  if (!(flags & P.REUSE)) return out;
  let state = 1, literal = 1, offset = 0;
  for (let i = flags & P.IMPL_LIT ? 1 : 0; i < t.count; i++) {
    state = ((state << 1) | literal) & 0xff;
    if (t.kind[i] === MATCH) {
      if ((state & 3) === 1 && t.off[i] === offset) out[i] = 1;
      offset = t.off[i];
      literal = 0;
    } else literal = 1;
  }
  return out;
}

// --- writing --------------------------------------------------------------------------------------------------

interface Sink { bit(b: number): void; byte(v: number): void }

/** Counts the bits of a stream (to know how many go in its first, partial bit buffer byte). */
class Counter implements Sink {
  bits = 0;
  bytes = 0;
  bit(): void { this.bits++; }
  byte(): void { this.bytes++; }
}

/** Writes a stream in reading order. The first bit buffer byte holds `first` bits and the marker (unless aligned). */
class Writer implements Sink {
  out: number[] = [];
  private at = -1;
  private room = 0;
  private filled = 0;
  private readonly flags: number;
  constructor(flags: number, first: number) {
    this.flags = flags;
    if (!(flags & P.ALIGN)) { this.at = 0; this.out.push(0); this.room = first; this.filled = 0; this.mark(first); }
  }
  private mark(n: number): void {
    // the marker bit right after the n data bits of the first byte
    this.out[this.at] |= this.flags & P.BE ? 0x80 >> n : 1 << n;
  }
  bit(b: number): void {
    if (this.room === 0) { this.at = this.out.length; this.out.push(0); this.room = 8; this.filled = 0; }
    if (b) this.out[this.at] |= this.flags & P.BE ? 0x80 >> this.filled : 1 << this.filled;
    this.filled++;
    this.room--;
  }
  byte(v: number): void { this.out.push(v & 0xff); }
}

/** count bits of value, most significant first; with COPY_GT7 the whole bytes after the rest */
function putBits(s: Sink, flags: number, count: number, value: number): void {
  let bytes = 0;
  if (flags & P.COPY_GT7) { bytes = count >> 3; count &= 7; }
  const hi = bytes ? Math.floor(value / 2 ** (8 * bytes)) : value;
  for (let i = count - 1; i >= 0; i--) s.bit((hi >> i) & 1);
  for (let k = bytes - 1; k >= 0; k--) s.byte(Math.floor(value / 2 ** (8 * k)) & 0xff);
}

const putGamma = (s: Sink, code: number): void => { for (let i = 0; i < code; i++) s.bit(0); s.bit(1); };

function emit(s: Sink, data: Uint8Array, t: Tokens, e: Encoding, flags: number, header: boolean): void {
  if (header) {
    // the length table, then the offset tables from the longest lengths down to length 1
    const order = [e.len, ...[...e.off].reverse()];
    for (const table of order) for (const b of table) {
      if (flags & P.COPY_GT7) { putBits(s, flags, 3, b & 7); putBits(s, flags, 1, b >> 3); }
      else putBits(s, flags, 4, b);
    }
  }
  const lb = bases(e.len), ob = e.off.map(bases);
  const reuse = reuses(t, flags);
  let pos = 0, state = 1, literal = 1;
  for (let i = 0; i < t.count; i++) {
    const kind = t.kind[i], len = t.len[i];
    const first = i === 0 && flags & P.IMPL_LIT;
    if (!first) state = ((state << 1) | literal) & 0xff;
    if (kind === LIT) {
      if (!first) s.bit(1);
      s.byte(data[pos]);
      literal = 1;
    } else if (kind === SEQ) {
      s.bit(0); putGamma(s, 17); putBits(s, flags, 16, len);
      for (let k = 0; k < len; k++) s.byte(data[pos + k]);
      literal = 1;
    } else {
      const g = bucketOf(lb, e.len, len);
      s.bit(0); putGamma(s, g); putBits(s, flags, e.len[g], len - lb[g]);
      if (flags & P.REUSE && (state & 3) === 1) s.bit(reuse[i]);
      if (!reuse[i]) {
        const tb = tableOf(len, flags), b = bucketOf(ob[tb], e.off[tb], t.off[i]);
        putBits(s, flags, TABLE_BITS[tb], b);
        putBits(s, flags, e.off[tb][b], t.off[i] - ob[tb][b]);
      }
      literal = 0;
    }
    pos += len;
  }
  s.bit(0); putGamma(s, 16);
}

function bucketOf(base: readonly number[], bits: readonly number[], v: number): number {
  for (let i = 0; i < base.length; i++) if (v >= base[i] && v < base[i] + (1 << bits[i])) return i;
  throw new Error(`${v} has no bucket in the encoding`);
}

/** The stream of a parse, in reading order; `header: false` leaves the encoding out (Exomizer's -E). */
export function writeStream(data: Uint8Array, t: Tokens, e: Encoding, flags: number, header = true): Uint8Array {
  const c = new Counter();
  emit(c, data, t, e, flags, header);
  const w = new Writer(flags, c.bits & 7);
  emit(w, data, t, e, flags, header);
  return Uint8Array.from(w.out);
}

/** The size of a parse's stream: its bits (header and literal bytes included) and the bytes writeStream writes. */
export function streamSize(data: Uint8Array, t: Tokens, e: Encoding, flags: number, header = true): { bits: number; bytes: number } {
  const c = new Counter();
  emit(c, data, t, e, flags, header);
  const buffers = flags & P.ALIGN ? Math.ceil(c.bits / 8) : 1 + (c.bits >> 3);
  return { bits: c.bits + 8 * c.bytes, bytes: buffers + c.bytes };
}

// --- reading --------------------------------------------------------------------------------------------------

export interface Decoded {
  data: Uint8Array;
  encoding: Encoding;
  /** the bytes of the stream read */
  read: number;
  /**
   * The in-place safety margin: the largest number of stream bytes still unread, less the data bytes still to be
   * written, at any write. A stream that starts this many bytes before the data (backward), or ends this many
   * after it (forward), is never written over before it is read.
   */
  safety: number;
  tokens: { literals: number; sequences: number; matches: number; reused: number };
}

export class StreamError extends Error {}

/** Decrunch a stream (in reading order) of any protocol. `encoding`: the tables of a stream written without them. */
export function readStream(stream: Uint8Array, flags: number, encoding?: Encoding, maxOut = 1 << 24): Decoded {
  let at = 0, bitbuf = 0;
  const byte = (): number => {
    if (at >= stream.length) throw new StreamError(`The stream ends after ${stream.length} bytes, in the middle of a token.`);
    return stream[at++];
  };
  const rotate = (carry: number): number => {
    if (flags & P.BE) { const out = (bitbuf >> 7) & 1; bitbuf = ((bitbuf << 1) | carry) & 0xff; return out; }
    const out = bitbuf & 1; bitbuf = (bitbuf >> 1) | (carry ? 0x80 : 0); return out;
  };
  const bits = (count: number): number => {
    let bytes = 0;
    if (flags & P.COPY_GT7) { bytes = count >> 3; count &= 7; }
    let v = 0;
    while (count-- > 0) {
      let c = rotate(0);
      if (bitbuf === 0) { bitbuf = byte(); c = rotate(1); }
      v = (v << 1) | c;
    }
    while (bytes-- > 0) v = v * 256 + byte();
    return v;
  };
  const gamma = (): number => { let g = 0; while (bits(1) === 0) if (++g > 17) throw new StreamError('A gamma code is longer than 17 bits.'); return g; };

  if (!(flags & P.ALIGN)) bitbuf = byte();
  const n = tableCount(flags);
  let enc = encoding;
  if (!enc) {
    const read = (size: number) => Array.from({ length: size }, () => (flags & P.COPY_GT7 ? bits(3) | (bits(1) << 3) : bits(4)));
    const len = read(16);
    const off: number[][] = [];
    for (let t = n - 1; t >= 0; t--) off[t] = read(tableSize(t));
    enc = { len, off };
  }
  const lb = bases(enc.len), ob = enc.off.map(bases);
  const out: number[] = [];
  const tokens = { literals: 0, sequences: 0, matches: 0, reused: 0 };
  let safety = 0, state = 1, literal = 1, offset = 0;
  // the margin a write needs is the stream bytes still unread less the data bytes still to come after it; those are
  // only known at the end, so every write keeps how much was unread
  const unreadAt: number[] = [];
  const write = (v: number) => {
    out.push(v);
    unreadAt.push(stream.length - at);
    if (out.length > maxOut) throw new StreamError(`The stream decrunches to more than ${maxOut} bytes.`);
  };

  let first = !!(flags & P.IMPL_LIT);
  for (;;) {
    if (first) { first = false; write(byte()); tokens.literals++; literal = 1; continue; }
    state = ((state << 1) | literal) & 0xff;
    if (bits(1)) { write(byte()); tokens.literals++; literal = 1; continue; }
    const g = gamma();
    if (g === 16) break;
    if (g === 17) {
      const len = bits(16);
      for (let k = 0; k < len; k++) write(byte());
      tokens.sequences++;
      literal = 1;
      continue;
    }
    const len = lb[g] + bits(enc.len[g]);
    let reuse = 0;
    if (flags & P.REUSE && (state & 3) === 1) reuse = bits(1);
    if (!reuse) {
      const tb = tableOf(len, flags);
      const b = bits(TABLE_BITS[tb]);
      if (b >= tableSize(tb)) throw new StreamError(`Offset bucket ${b} is past table ${tb}.`);
      offset = ob[tb][b] + bits(enc.off[tb][b]);
    } else tokens.reused++;
    if (offset > out.length || offset === 0) throw new StreamError(`A match at byte ${out.length} reaches ${offset} bytes back, before the start.`);
    for (let k = 0; k < len; k++) write(out[out.length - offset]);
    tokens.matches++;
    literal = 0;
  }
  const total = out.length;
  for (let i = 0; i < total; i++) safety = Math.max(safety, unreadAt[i] - (total - 1 - i));
  return { data: Uint8Array.from(out), encoding: enc, read: at, safety, tokens };
}
