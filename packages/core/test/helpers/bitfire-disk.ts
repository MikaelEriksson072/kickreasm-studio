/* A writer for Bitfire disks, to test the reader with (c64/bitfire-disk.ts): the directory and sector order of
 * d64write's formats (0.7, 1.0, after 1.1 and 1.2), and files packed the way dali writes them (with a simple greedy
 * packer, not dali's own). Nothing of Bitfire's own code is on the disks. */
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
