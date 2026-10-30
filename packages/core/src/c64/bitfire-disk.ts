/* The files of a Bitfire disk (spec 13.5c). Bitfire, Bitbreaker's loader, has no load script: each part loads the next
 * file (`link_load_next_comp`) or one by its number. What comes closest is the command line of d64write, Bitfire's disk
 * builder, which lists the files in the order they load (`-b`), the boot program (`--boot`), the side (`--side`) and
 * the ordinary files (`-s`). Bitfire keeps its files out of the disk's directory, in a directory of its own on track 18:
 * each file's load address and length, and where the first file of the sector starts. Reading it back, and the sectors
 * in the order d64write fills them, gives every file; one packed with Bitfire's packer, bitnax (0.x) or dali (1.x), is
 * unpacked.
 *
 * The formats are those of d64write (BSD licence), which changed over the versions:
 * - up to 0.7 (2020): 6 bytes a file in 18/18, 18/17 and 18/16 (its track and sector, load address, length - 1), the
 *   side in byte $ff; a file starts in a sector of its own; packed with bitnax;
 * - 1.0 and 1.1 (2022): 4 bytes a file (load address, length - 1) in 18/18 and 18/17, then the first file's track,
 *   its sector's number on the track (the n-th d64write filled) and its first byte, and the side in $fc-$ff;
 * - after 1.1: the same with those 4 bytes first and the load address's high byte - 1;
 * - 1.2 and later: the 4 bytes first, then a column of 63 low bytes, one of high bytes - 1 and two of length - 1.
 * From 1.0 the files follow each other with no gap, from track 1 sector 0, all 256 bytes of a sector theirs. d64write
 * fills a track every 4th sector (from 1.2: every 3rd from track 18 on), then again from sector 1, 2 and 3. The side is
 * $f0 + side - 1.
 *
 * dali (Bitfire 1.x) writes where the file unpacks to (2 bytes), then a zx0 stream: a literal (Elias-gamma length, then
 * the bytes), after a literal a match with the last offset (0) or a new one (1), after a match a literal (0) or a new
 * match (1). Numbers are interlaced Elias gamma (a 0 before each further bit, a 1 at the end), 8 low bits first from 256
 * on; bits come from the top of a byte, read when they are needed. A new offset is a number (its high part + 1) and a
 * byte (7 low bits, then 1 for length 2, else the length - 1 follows without its first 0); 256 ends the stream. A file
 * packed in place has no end: it ends where its writing reaches its reading, the rest being the bytes as they are.
 *
 * bitnax (Bitfire 0.x, lz.c and resident.asm of 0.7; the same from 2016 to 0.7) writes where the file unpacks to and
 * where unpacking ends (2 bytes each; with --overlap only the first), then the stream. Bits come from the top of a byte,
 * read when they are needed, between the bytes. A type bit comes before each literal (1) and match (0), but not before
 * the match that follows a literal shorter than 256. A literal's length is a 1 and the bit for each of its bits after
 * the first, then a 0 (256 is 0); its bytes follow. A match's length is a 0 for 2, else a 1, then each bit of length - 1
 * after the first, followed by 0, the last by 1 (257 ends the stream). 2 bits more make a prefix of 3 that gives the
 * offset's bits (after a match of 2: 8, 3, 6 or 10, else 4, 7, 10 or 13); offset - 1 follows, its bits inverted when it
 * has fewer than 8, else its high bits and then its low byte inverted. A file packed in place (the default) ends at the
 * end address, the rest being the bytes as they are; one unpacked elsewhere has the end after that. Bitfire's first
 * demos (2014-2015: Comaland, Fantasmolytic) have no end address, always the end, and the offsets in another order: 3,
 * 6, 8 and 10 after a match of 2. */
import type { Addr } from '../types';
import { parseD64, petsciiName, sectorOffset, sectorsOnTrack } from './d64';

/** the format of the directory: 0.x, 1.0 (and 1.1), after 1.1, 1.2 and later */
export type BitfireFormat = '0.x' | '1.0' | '1.1+' | '1.2';

export interface BitfireUnpacked {
  start: Addr; end: Addr; bytes: Uint8Array;
  /** packed in place: it ends where it started to be read */
  inplace: boolean;
}

export interface BitfireFile {
  /** its number (from 0), as `link_load_comp` takes it */
  n: number;
  /** where the loader puts it, and its bytes as they are on the disk */
  load: Addr; end: Addr; bytes: Uint8Array;
  /** where it starts: the sector, and the byte in it */
  track: number; sector: number; offset: number;
  /** what it unpacks to (bitnax for 0.x, else dali); null: not packed, or bitnax that copies from memory before it */
  unpacked: BitfireUnpacked | null;
}

export interface BitfireDisk {
  format: BitfireFormat;
  /** the disk side, 1-15 (`--side`) */
  side: number;
  files: BitfireFile[];
  /** the header and id (`-h`, `-i`) */
  header: string; id: string;
  /** the boot program (`--boot`, on track 18) and the ordinary files (`-s`) in the disk's directory */
  boot: string | null; standard: string[];
  /** the lines of a dirart (`-a`), each leading to the boot program or a DEL entry; 0: none */
  dirart: number;
  /** 0.x: packed as Bitfire's first demos are (2014-2015), bitnax's offsets in another order */
  oldBitnax: boolean;
}

const SIZES: Record<number, 35 | 40> = { 174848: 35, 175531: 35, 196608: 40, 197376: 40 };
const isSide = (b: number) => b >= 0xf0 && b <= 0xfe;

/** d64write's order of a track's sectors on a fresh disk: every `il`-th from sector 0, then from 1, 2 ... */
function trackOrder(t: number, il: number): number[] {
  const n = sectorsOnTrack(t), out: number[] = [];
  for (let r = 0; r < il; r++) for (let s = r; s < n; s += il) out.push(s);
  return out;
}

interface Block { track: number; sector: number; index: number }
/** every sector but track 18's, in the order d64write fills them */
function blocks(tracks: number, split: boolean): Block[] {
  const out: Block[] = [];
  for (let t = 1; t <= tracks; t++) if (t !== 18) trackOrder(t, split && t >= 18 ? 3 : 4).forEach((sector, index) => out.push({ track: t, sector, index }));
  return out;
}

/** A dali file unpacked, read from its place in memory (writing may reach the bytes it reads); null when it is not one. */
export function unpackDali(data: Uint8Array, load: Addr): BitfireUnpacked | null {
  if (data.length < 3 || load + data.length > 0x10000) return null;
  const mem = new Uint8Array(0x10000);
  mem.set(data, load);
  const end = load + data.length, start = data[0] | (data[1] << 8);
  let src = load + 2, dst = start, mask = 0, bits = 0, last = 1;
  const byte = () => { if (src >= end) throw new RangeError('past the end'); return mem[src++]; };
  const bit = () => { if (!(mask >>= 1)) { mask = 0x80; bits = byte(); } return bits & mask ? 1 : 0; };
  const elias = (skip: boolean) => {
    const raw: number[] = [];
    while (skip || !bit()) { skip = false; raw.push(bit()); if (raw.length > 16) throw new RangeError('no number'); }
    if (raw.length < 8) return raw.reduce((v, b) => (v << 1) | b, 1);
    // from 256 on the 8 low bits come first
    return (raw.slice(8).reduce((v, b) => (v << 1) | b, 1) << 8) | raw.slice(0, 8).reduce((v, b) => (v << 1) | b, 0);
  };
  const copy = (n: number) => { for (let i = 0; i < n; i++, dst++) { if (dst > 0xffff) throw new RangeError('past $ffff'); mem[dst] = mem[dst - last]; } };
  const done = (): BitfireUnpacked => ({ start, end, bytes: mem.slice(start, end), inplace: true });
  try {
    let state: 'lit' | 'rep' | 'match' = 'lit';
    for (;;) {
      if (state === 'lit') {
        const n = elias(false);
        for (let i = 0; i < n; i++, dst++) { if (dst > 0xffff) return null; mem[dst] = byte(); }
        state = bit() ? 'match' : 'rep';
      } else if (state === 'rep') {
        copy(elias(false));
        if (dst === src) return done();
        state = bit() ? 'match' : 'lit';
      } else {
        const hi = elias(false);
        if (hi === 256) return src === end ? { start, end: dst, bytes: mem.slice(start, dst), inplace: false } : null;
        const b = byte();
        const n = b & 1 ? 2 : elias(true) + 1;
        last = (((hi - 1) << 7) | (b >> 1)) + 1;
        copy(n);
        if (dst === src) return done();
        state = bit() ? 'match' : 'lit';
      }
    }
  } catch { return null; }
}

/** the bits of a match's offset after each of the 8 prefixes (0-3 after a match of 2 bytes, 4-7 after a longer one): as
 *  bitnax writes them from 2016, and in the order of Bitfire's first demos (2014-2015) */
const OFFSET_BITS = { new: [8, 3, 6, 10, 4, 7, 10, 13], old: [3, 6, 8, 10, 4, 7, 10, 13] };

/** A bitnax file unpacked (Bitfire 0.x), read from its place in memory; null when it is not one, or when a match copies
 *  from memory before where it unpacks to (packed with a dictionary). `old`: packed as Bitfire's first demos are
 *  (2014-2015), with the offsets in another order. */
export function unpackBitnax(data: Uint8Array, load: Addr, old = false): BitfireUnpacked | null {
  // from 2016 the end address follows where it unpacks to, unless it was packed with --overlap
  return (!old && bitnax(data, load, true, OFFSET_BITS.new)) || bitnax(data, load, false, old ? OFFSET_BITS.old : OFFSET_BITS.new);
}

function bitnax(data: Uint8Array, load: Addr, withEnd: boolean, offsetBits: number[]): BitfireUnpacked | null {
  const head = withEnd ? 4 : 2;
  if (data.length <= head || load + data.length > 0x10000) return null;
  const mem = new Uint8Array(0x10000);
  mem.set(data, load);
  const end = load + data.length, start = data[0] | (data[1] << 8), stop = withEnd ? data[2] | (data[3] << 8) : -1;
  if (withEnd && stop < start) return null;
  let src = load + head, dst = start, bits = 0, left = 0;
  const byte = () => { if (src >= end) throw new RangeError('past the end'); return mem[src++]; };
  const bit = () => { if (!left) { bits = byte(); left = 8; } return (bits >> --left) & 1; };
  // a longer match's length - 1: a 1, then each bit followed by 0, the last by 1; 8 bits (0) end the stream
  const longer = () => { let n = 1; do n = ((n << 1) | bit()) & 0xff; while (!bit()); return n; };
  const upTo = (e: number, inplace: boolean): BitfireUnpacked => ({ start, end: e, bytes: mem.slice(start, e), inplace });
  // at the end address: packed in place (the reading is there too, the rest of the file is the rest as it is), or
  // unpacked elsewhere with at most the end left (a type bit and the match that ends, 18 bits; it is not read, and the
  // writing may have reached it)
  const atStop = () => src === stop ? upTo(end, true) : end - src <= 3 ? upTo(stop, false) : null;
  try {
    for (let typed = true; ;) {
      if (typed && bit()) {
        // a literal: a 1, then a bit after each 1 until a 0 (256 is 0)
        let n = 1;
        while (bit()) n = ((n << 1) | bit()) & 0xff;
        for (let i = 0; i < (n || 256); i++, dst++) { if (dst > 0xffff) return null; mem[dst] = byte(); }
        // a match follows, but after 256 a type bit (and the end is checked, by its high byte when its low one is 0)
        typed = !n;
        if (typed && withEnd && !(stop & 0xff) && dst >> 8 === stop >> 8) return dst === stop ? atStop() : null;
        continue;
      }
      // a match: its length - 1 (1 after a 0), the prefix's 2 bits more, the offset's bits and, from 8, its low byte
      const long = bit(), n = long ? longer() : 1;
      // the end, with all of the file read (not checked against the end address: with --relocate-to bitnax moves that
      // twice, past the end)
      if (!n) return src === end ? upTo(dst, false) : null;
      const w = offsetBits[(long << 2) | (bit() << 1) | bit()];
      let v = 0;
      for (let i = 0; i < (w & 7); i++) v = (v << 1) | bit();
      // the offset - 1: its bits inverted under 8, else its high bits and its low byte inverted
      const offset = (w < 8 ? ~v & ((1 << w) - 1) : (v << 8) | (~byte() & 0xff)) + 1;
      if (offset > dst - start) return null;
      for (let i = 0; i <= n; i++, dst++) { if (dst > 0xffff) return null; mem[dst] = mem[dst - offset]; }
      if (dst === stop) return atStop();
      typed = true;
    }
  } catch { return null; }
}

interface Entry { load: Addr; len: number; track?: number; sector?: number }

/** The files of a Bitfire disk; null when it is not one. */
export function readBitfireDisk(image: Uint8Array): BitfireDisk | null {
  const tracks = SIZES[image.length];
  if (!tracks) return null;
  const sec = (t: number, s: number) => { const o = sectorOffset(t, s, tracks); return image.subarray(o, o + 256); };
  const s18 = sec(18, 18);
  type Try = { format: BitfireFormat; split: boolean };
  const tries: Try[] = [];
  if (s18[0] === 1 && s18[1] === 0 && s18[2] === 0 && isSide(s18[3])) tries.push({ format: '1.2', split: true }, { format: '1.2', split: false }, { format: '1.1+', split: false }, { format: '1.1+', split: true });
  if (s18[0xfc] === 1 && s18[0xfd] === 0 && s18[0xfe] === 0 && isSide(s18[0xff])) tries.push({ format: '1.0', split: false }, { format: '1.0', split: true });
  if (s18[0] === 1 && s18[1] === 0 && !s18[0xfc] && isSide(s18[0xff])) tries.push({ format: '0.x', split: false });
  let best: { disk: BitfireDisk; score: number } | null = null;
  for (const t of tries) {
    const got = readAs(t.format, t.split);
    if (got && (!best || got.score > best.score)) best = got;
  }
  // a directory at the front is Bitfire 1.1 or later, which packs with dali: a file of it unpacks
  if (!best || (best.score === 0 && (best.disk.format === '1.2' || best.disk.format === '1.1+'))) return null;
  return best.disk;

  function entries(format: BitfireFormat): { list: Entry[]; heads: number[][] } {
    const list: Entry[] = [], heads: number[][] = [];
    if (format === '0.x') {
      for (const ds of [18, 17, 16]) {
        const s = sec(18, ds);
        for (let i = 0; i < 42; i++) {
          const e = s.subarray(i * 6, i * 6 + 6);
          if (!e[0]) return { list, heads };
          list.push({ track: e[0], sector: e[1], load: e[2] | (e[3] << 8), len: (e[4] | (e[5] << 8)) + 1 });
        }
      }
      return { list, heads };
    }
    for (const ds of [18, 17]) {
      const s = sec(18, ds);
      heads.push(format === '1.0' ? [s[0xfc], s[0xfd], s[0xfe]] : [s[0], s[1], s[2]]);
      for (let i = 0; i < 63; i++) {
        const [lo, hi, l0, l1] = format === '1.2' ? [s[4 + i], s[67 + i], s[130 + i], s[193 + i]]
          : format === '1.1+' ? [s[4 + i * 4], s[5 + i * 4], s[6 + i * 4], s[7 + i * 4]] : [s[i * 4], s[i * 4 + 1], s[i * 4 + 2], s[i * 4 + 3]];
        if (!(lo | hi | l0 | l1)) return { list, heads };
        list.push({ load: lo | (((format === '1.0' ? hi : hi + 1) & 0xff) << 8), len: (l0 | (l1 << 8)) + 1 });
      }
    }
    return { list, heads };
  }

  function readAs(format: BitfireFormat, split: boolean): { disk: BitfireDisk; score: number } | null {
    const { list, heads } = entries(format);
    // (one file of 0.x says little: its track and sector are what any disk could have there)
    if (list.length < (format === '0.x' ? 2 : 1) || list.some(e => e.load + e.len > 0x10000)) return null;
    const order = blocks(tracks, split);
    const at = new Map(order.map((b, i) => [`${b.track}/${b.sector}`, i]));
    const files: BitfireFile[] = [];
    let pos = 0; // in the stream of sectors, from 1/0
    for (const [n, e] of list.entries()) {
      if (e.track != null) {
        // 0.x: the file starts in the sector its entry names, the one after the last file's
        const i = at.get(`${e.track}/${e.sector}`);
        if (i == null || (n > 0 && i * 256 !== pos)) return null;
        pos = i * 256;
      }
      const first = order[pos >> 8];
      if (!first || pos + e.len > order.length * 256) return null;
      // a directory sector's first file: where it starts, as the sector says (when the file before ended with a sector,
      // d64write names that sector, at byte 256 written as 0)
      if (format !== '0.x' && n % 63 === 0) {
        const [t, s, o] = heads[n / 63], prev = order[(pos >> 8) - 1];
        const named = (b: Block | undefined, off: number) => !!b && t === b.track && s === b.index && o === off;
        if (!named(first, pos & 0xff) && !(!(pos & 0xff) && named(prev, 0))) return null;
      }
      const bytes = new Uint8Array(e.len);
      for (let k = 0; k < e.len;) {
        const b = order[(pos + k) >> 8], o = (pos + k) & 0xff, take = Math.min(256 - o, e.len - k);
        bytes.set(sec(b.track, b.sector).subarray(o, o + take), k);
        k += take;
      }
      files.push({ n, load: e.load, end: e.load + e.len, bytes, track: first.track, sector: first.sector, offset: pos & 0xff, unpacked: format === '0.x' ? null : unpackDali(bytes, e.load) });
      pos += format === '0.x' ? Math.ceil(e.len / 256) * 256 : e.len;
    }
    // 0.x: one depacker for the disk, the order of the offsets that unpacks more of its files
    let oldBitnax = false;
    if (format === '0.x') {
      const [now, then] = [false, true].map(old => files.map(f => unpackBitnax(f.bytes, f.load, old)));
      oldBitnax = then.filter(Boolean).length > now.filter(Boolean).length;
      files.forEach((f, i) => { f.unpacked = (oldBitnax ? then : now)[i]; });
    }
    // the directory: the boot program on track 18, other files; a dirart's lines lead to the boot program or are DEL,
    // with 0 blocks
    const img = parseD64(image);
    const boot = img.files.find(f => f.type !== 'DEL' && f.track === 18);
    const art = img.files.filter(f => (f.type !== 'DEL' && f.track === 18) || (f.type === 'DEL' && !f.blocks)).length;
    const bam = sec(18, 0);
    const text = (a: number, n: number) => petsciiName(bam.subarray(a, a + n)).trim();
    const side = (format === '1.0' || format === '0.x' ? s18[0xff] : s18[3]) - 0xef;
    return {
      score: files.filter(f => f.unpacked).length,
      disk: {
        format, side, files, header: text(0x90, 16), id: text(0xa2, 5), boot: boot?.name ?? null, dirart: art > 1 ? art : 0, oldBitnax,
        standard: img.files.filter(f => f.type !== 'DEL' && f.track !== 18 && f.blocks > 0).map(f => f.name),
      },
    };
  }
}

const hx = (v: number, w: number) => v.toString(16).padStart(w, '0');

/** the versions a format stands for */
export const BITFIRE_VERSION: Record<BitfireFormat, string> = { '0.x': 'Bitfire 0.x', '1.0': 'Bitfire 1.0 or 1.1', '1.1+': 'Bitfire after 1.1', '1.2': 'Bitfire 1.2 or later' };

/** A file's name in the rebuilt script: its number and where it unpacks to, or loads when it is not packed (the real
 *  names are not on the disk). */
export const bitfireFileName = (f: BitfireFile): string => `file${hx(f.n, 2)}_${hx(f.unpacked?.start ?? f.load, 4)}.lz`;

const shellName = (name: string) => { const s = name.toLowerCase(); return /^[\w.-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`; };

/** d64write's command line that writes the disk again (with the files as they are on it), each file in a comment. */
export function d64writeScript(disk: BitfireDisk, name: string): string[] {
  const n = disk.files.length;
  const out = [
    `# d64write command line, rebuilt by Mimir Studio from ${name} (${BITFIRE_VERSION[disk.format]}${disk.oldBitnax ? ', packed as in 2014-2015' : ''}): ${n} file${n === 1 ? '' : 's'} on side ${disk.side}.`,
    '# Bitfire has no load script: a part loads the next file (link_load_next_comp) or one by its number, so this is the',
    '# order they load in. The file names are made up: each is the file as it is on the disk, named after its number and',
    `# where it unpacks to (or loads, when it is not packed with ${disk.format === '0.x' ? 'bitnax' : 'dali'}).`,
  ];
  for (const f of disk.files) {
    const u = f.unpacked;
    const what = u ? `unpacks to $${hx(u.start, 4)}-$${hx(u.end - 1, 4)} (${u.end - u.start} bytes)` : disk.format === '0.x' ? 'not packed (or bitnax copying from memory before it)' : 'not packed';
    out.push(`#   ${bitfireFileName(f).padEnd(16)} loads at $${hx(f.load, 4)}-$${hx(f.end - 1, 4)} (${f.bytes.length} bytes), ${what}`);
  }
  if (disk.dirart) out.push(`# The directory is a dirart of ${disk.dirart} lines (dirart.prg and boot.prg are made-up names).`);
  const lines = [`d64write -c ${shellName(name)} -h ${shellName(disk.header)} -i ${shellName(disk.id)} --side ${disk.side}`];
  // a boot program whose name is a line of a dirart gets a made-up one, and so does the dirart
  if (disk.boot != null) lines.push(`--boot ${shellName(!disk.dirart && /^[\x20-\x7e]*[a-z0-9][\x20-\x7e]*$/i.test(disk.boot) ? `${disk.boot}.prg` : 'boot.prg')}`);
  if (disk.dirart) lines.push(`-a dirart.prg ${disk.dirart}`);
  for (const f of disk.files) lines.push(`-b ${bitfireFileName(f)}`);
  for (const s of disk.standard) lines.push(`-s ${shellName(`${s}.prg`)}`);
  out.push('', ...lines.map((l, i) => `${i ? '  ' : ''}${l}${i < lines.length - 1 ? ' \\' : ''}`));
  return out;
}
