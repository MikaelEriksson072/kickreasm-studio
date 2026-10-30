/* A writer for Bitfire disks, to test the reader with (c64/bitfire-disk.ts): the directory and sector order of
 * d64write's formats (0.7, 1.0, after 1.1 and 1.2), and files packed the way dali and bitnax write them (with simple
 * greedy packers, not Bitfire's own). Nothing of Bitfire's own code is on the disks. */
import { makeD64, sectorsOnTrack, type BitfireFormat } from '../../src';

/** dali's writer: bits from the top of a byte, put in the stream when the first is written */
export class Dali {
  out: number[] = [];
  private mask = 0;
  private at = 0;
  bit(v: number) {
    if (!(this.mask & 0xff)) { this.mask = 0x80; this.at = this.out.length; this.out.push(0); }
    if (v) this.out[this.at] |= this.mask;
    this.mask >>= 1;
  }
  /** interlaced Elias gamma; from 256 on the 8 low bits first; `skip`: without the first 0 (and the 1 of a 1) */
  elias(value: number, skip = false) {
    const bits = 31 - Math.clz32(value);
    let i = 1 << bits;
    if (bits >= 8) { value &= ~i; value = (value >> 8) | ((value & 0xff) << (bits - 8)); }
    while ((i >>= 1) > 0) { if (!skip) this.bit(0); skip = false; this.bit(value & i ? 1 : 0); }
    if (!skip) this.bit(1);
  }
  literal(bytes: number[], first = false) { if (!first) this.bit(0); this.elias(bytes.length); this.out.push(...bytes); }
  rep(len: number) { this.bit(0); this.elias(len); }
  match(len: number, offset: number) {
    this.bit(1); this.elias(((offset - 1) >> 7) + 1);
    this.out.push((((offset - 1) & 0x7f) << 1) | (len === 2 ? 1 : 0));
    this.elias(len - 1, true);
  }
  end() { this.bit(1); this.elias(256); }
}

/** `data` packed for `dest`, with an end: the longest copy from up to 4 KB back where there is one of 3 bytes or more,
 *  else a literal (the first byte always is one) */
export function packDali(data: number[], dest: number): number[] {
  const w = new Dali();
  let lit: number[] = [], prev: 'lit' | 'copy' | null = null, last = 1;
  for (let i = 0; i < data.length;) {
    let len = 0, off = 0;
    for (let o = 1; i > 0 && o <= Math.min(i, 4096); o++) {
      let n = 0;
      while (i + n < data.length && data[i + n] === data[i + n - o]) n++;
      if (n > len) { len = n; off = o; }
    }
    if (len < 3) { lit.push(data[i++]); continue; }
    if (lit.length) { w.literal(lit, prev === null); lit = []; prev = 'lit'; }
    if (prev === 'lit' && off === last) w.rep(len); else w.match(len, off);
    last = off; prev = 'copy'; i += len;
  }
  if (lit.length) w.literal(lit, prev === null);
  w.end();
  return [dest & 0xff, dest >> 8, ...w.out];
}

/** the bits of a match's offset after each prefix (0-3: a match of 2 bytes), from 2016 and before (Bitfire's first demos) */
const BITNAX_OFFSETS = { new: [8, 3, 6, 10, 4, 7, 10, 13], old: [3, 6, 8, 10, 4, 7, 10, 13] };

/** bitnax's writer (Bitfire 0.x): a type bit before each literal and match (not before a match after a literal shorter
 *  than 256), bits from the top of a byte put in the stream when the first is written, as dali's are */
export class Bitnax {
  out: number[] = [];
  private mask = 0;
  private at = 0;
  private afterLiteral = false;
  constructor(private old = false) {}
  bit(v: number) {
    if (!(this.mask & 0xff)) { this.mask = 0x80; this.at = this.out.length; this.out.push(0); }
    if (v) this.out[this.at] |= this.mask;
    this.mask >>= 1;
  }
  /** 1-256 bytes: a 1, then for each bit of the length after its first a 1 and the bit, then a 0 */
  literal(bytes: number[]) {
    this.bit(1);
    const n = bytes.length;
    for (let b = 30 - Math.clz32(n); b >= 0; b--) { this.bit(1); this.bit((n >> b) & 1); }
    this.bit(0);
    this.out.push(...bytes);
    this.afterLiteral = n < 256;
  }
  /** 2-256 bytes from `offset` back: 0 for 2, else 1 and the bits of length - 1 after its first, each followed by 1 when
   *  it is the last; 2 bits more of the prefix, the narrowest that holds the offset; the offset - 1, inverted when it
   *  has fewer than 8 bits, else its high bits and its low byte inverted */
  match(len: number, offset: number) {
    if (!this.afterLiteral) this.bit(0);
    this.afterLiteral = false;
    const m = len - 1, widths = BITNAX_OFFSETS[this.old ? 'old' : 'new'];
    this.bit(len > 2 ? 1 : 0);
    if (len > 2) for (let b = 30 - Math.clz32(m); b >= 0; b--) { this.bit((m >> b) & 1); this.bit(b ? 0 : 1); }
    const p = [0, 1, 2, 3].map(i => i + (len > 2 ? 4 : 0)).filter(i => offset <= 1 << widths[i]).sort((a, b) => widths[a] - widths[b])[0];
    this.bit(p & 2); this.bit(p & 1);
    const w = widths[p], o = offset - 1;
    if (w < 8) for (let b = w - 1; b >= 0; b--) this.bit(~o & (1 << b));
    else { for (let b = w - 1; b >= 8; b--) this.bit(o & (1 << b)); this.out.push(~o & 0xff); }
  }
  /** the end: a match of 257 */
  end() {
    if (!this.afterLiteral) this.bit(0);
    this.bit(1);
    for (let b = 7; b >= 0; b--) { this.bit(0); this.bit(b ? 0 : 1); }
  }
}

/** How a file is packed: in place (the default: an end address, the bytes after where it stops as they are), for
 *  somewhere else (--load-addr: the end address, then the end), with --overlap (no end address, the end), or as
 *  Bitfire's first demos are (the same, the offsets in another order). */
export type BitnaxHow = 'inplace' | 'elsewhere' | 'overlap' | 'old';

/** `data` packed with bitnax for `dest`: the longest copy from up to 8 KB back (1 KB for 2 bytes), else a literal; in
 *  place it loads at `load`, so that it ends where `data` does */
export function packBitnax(data: number[], dest: number, how: BitnaxHow = 'inplace'): { bytes: number[]; load: number } {
  const w = new Bitnax(how === 'old');
  const steps: ([number[]] | [number, number])[] = [];
  let lit: number[] = [];
  const flush = () => { for (let i = 0; i < lit.length; i += 256) steps.push([lit.slice(i, i + 256)]); lit = []; };
  for (let i = 0; i < data.length;) {
    let len = 0, off = 0;
    for (let o = 1; o <= Math.min(i, 8192); o++) {
      let n = 0;
      while (n < 256 && i + n < data.length && data[i + n] === data[i + n - o]) n++;
      if (n > len && (n > 2 || o <= 1024)) { len = n; off = o; }
    }
    if (len < 2) { lit.push(data[i++]); continue; }
    flush(); steps.push([len, off]); i += len;
  }
  if (how !== 'inplace') flush();
  // in place: coded up to where the writing is furthest ahead of the reading (at a match's end), so that it never
  // passes it, and the bytes after that as they are (bitnax finds the place by the bits that are left)
  const all = new Bitnax();
  let cut = steps.length, at = data.length;
  if (how === 'inplace') {
    let best = 0, c = 0;
    cut = 0; at = 0;
    steps.forEach((s, k) => {
      if (s.length === 1) all.literal(s[0]); else all.match(s[0], s[1]);
      c += s.length === 1 ? s[0].length : s[0];
      if (c - all.out.length >= best) { best = c - all.out.length; cut = k + 1; at = c; }
    });
  }
  for (const s of steps.slice(0, cut)) if (s.length === 1) w.literal(s[0]); else w.match(s[0], s[1]);
  if (how !== 'inplace') w.end();
  const stop = dest + at, head = how === 'inplace' || how === 'elsewhere' ? [dest & 0xff, dest >> 8, stop & 0xff, stop >> 8] : [dest & 0xff, dest >> 8];
  const bytes = [...head, ...w.out, ...data.slice(at)];
  return { bytes, load: dest + data.length - bytes.length };
}

const offset = (t: number, s: number) => { let n = 0; for (let k = 1; k < t; k++) n += sectorsOnTrack(k); return (n + s) * 256; };
/** every sector but track 18's, as d64write fills them: every 4th (1.2: every 3rd from track 18), from 0, then 1 ... */
const order = (split: boolean) => {
  const out: [number, number][] = [];
  for (let t = 1; t <= 35; t++) {
    if (t === 18) continue;
    const il = split && t >= 18 ? 3 : 4;
    for (let r = 0; r < il; r++) for (let s = r; s < sectorsOnTrack(t); s += il) out.push([t, s]);
  }
  return out;
};

export interface FakeBitfireFile { load: number; bytes: number[] }

/** A disk as d64write writes it: the files, the boot program BOOT on track 18 and the file NOTE in the directory; with
 *  `dirart`, the directory's lines lead to the boot program instead of BOOT, each with 0 blocks. */
export function makeBitfireDisk(format: BitfireFormat, files: FakeBitfireFile[], o: { name?: string; side?: number; dirart?: string[] } = {}): Uint8Array {
  const side = o.side ?? 1;
  const boot = (o.dirart ?? ['BOOT']).map(name => ({ name, data: Uint8Array.from([0x01, 0x08, 0x60]) }));
  const img = makeD64({ name: o.name ?? 'BITFIRE DEMO', files: [...boot, { name: 'NOTE', type: 'SEQ', data: Uint8Array.from([0x41]) }] });
  // d64write puts the boot program on track 18
  boot.forEach((_, i) => { const e = offset(18, 1) + i * 32; img.set([18, 2], e + 3); if (o.dirart) img.set([0, 0], e + 30); });
  img.set([0x42, 0x46, 0x20, 0x20, 0x20, 0x20], offset(18, 0) + 0xa2); // its id: up to 5 characters, then spaces
  img.fill(0, offset(1, 0), offset(17, 20) + 256); // the bitfire files take the first tracks
  img.fill(0, offset(18, 16), offset(18, 18) + 256);
  const blocks = order(format === '1.2'), s18 = offset(18, 18);
  let pos = 0;
  files.forEach((f, n) => {
    // 63 files a directory sector (0.x: 42), from 18/18 down
    const per = format === '0.x' ? 42 : 63, ds = offset(18, 18 - Math.floor(n / per)), i = n % per;
    const len = f.bytes.length - 1;
    if (format === '0.x') img.set([...blocks[pos >> 8], f.load & 0xff, f.load >> 8, len & 0xff, len >> 8], ds + i * 6);
    else if (format === '1.2') [f.load & 0xff, (f.load >> 8) - 1, len & 0xff, len >> 8].forEach((b, c) => { img[ds + 4 + c * 63 + i] = b; });
    else if (format === '1.1+') img.set([f.load & 0xff, (f.load >> 8) - 1, len & 0xff, len >> 8], ds + 4 + i * 4);
    else img.set([f.load & 0xff, f.load >> 8, len & 0xff, len >> 8], ds + i * 4);
    f.bytes.forEach((b, k) => { const [t, s] = blocks[(pos + k) >> 8]; img[offset(t, s) + ((pos + k) & 0xff)] = b; });
    pos += format === '0.x' ? Math.ceil(f.bytes.length / 256) * 256 : f.bytes.length;
  });
  if (format === '0.x') img[s18 + 0xff] = 0xef + side;
  else img.set([1, 0, 0, 0xef + side], s18 + (format === '1.0' ? 0xfc : 0));
  return img;
}
