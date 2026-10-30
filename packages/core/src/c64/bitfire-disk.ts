/* The files of a Bitfire disk (spec 13.5c). Bitfire, Bitbreaker's loader, has no load script: each part loads the next
 * file (`link_load_next_comp`) or one by its number. What comes closest is the command line of d64write, Bitfire's disk
 * builder, which lists the files in the order they load (`-b`), the boot program (`--boot`), the side (`--side`) and
 * the ordinary files (`-s`). Bitfire keeps its files out of the disk's directory, in a directory of its own on track 18:
 * each file's load address and length, and where the first file of the sector starts. Reading it back, and the sectors
 * in the order d64write fills them, gives every file; one packed with dali, Bitfire's packer, is unpacked.
 *
 * The formats are those of d64write (BSD licence), which changed over the versions:
 * - up to 0.7 (2020): 6 bytes a file in 18/18, 18/17 and 18/16 (its track and sector, load address, length - 1), the
 *   side in byte $ff; a file starts in a sector of its own; packed with bitnax, which is not read here;
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
 * packed in place has no end: it ends where its writing reaches its reading, the rest being the bytes as they are. */
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
  /** what it unpacks to (dali); null: not packed with dali, or a bitnax file of Bitfire 0.x */
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
        format, side, files, header: text(0x90, 16), id: text(0xa2, 5), boot: boot?.name ?? null, dirart: art > 1 ? art : 0,
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
    `# d64write command line, rebuilt by Mimir Studio from ${name} (${BITFIRE_VERSION[disk.format]}): ${n} file${n === 1 ? '' : 's'} on side ${disk.side}.`,
    '# Bitfire has no load script: a part loads the next file (link_load_next_comp) or one by its number, so this is the',
    '# order they load in. The file names are made up: each is the file as it is on the disk, named after its number and',
    '# where it unpacks to (or loads, when it is not packed with dali).',
  ];
  for (const f of disk.files) {
    const u = f.unpacked;
    const what = u ? `unpacks to $${hx(u.start, 4)}-$${hx(u.end - 1, 4)} (${u.end - u.start} bytes)` : disk.format === '0.x' ? 'packed with bitnax or not packed (not read here)' : 'not packed';
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
