/* D64 disk images: the directory, reading a file, and writing one back (a new file, or in place of one), so Brokkr
 * packs files where they are, on the disk. 35 or 40 tracks, with or without error bytes (the error bytes are kept). */
import { BrokkrError } from './errors.ts';

export interface DiskFile {
  /** the name as PETSCII bytes turned into text ($a0 padding dropped) */
  name: string;
  type: 'DEL' | 'SEQ' | 'PRG' | 'USR' | 'REL';
  /** closed (not a splat file) and locked */
  closed: boolean;
  locked: boolean;
  track: number;
  sector: number;
  blocks: number;
  /** where its directory entry is: the sector's track and sector, and the entry's index (0-7) */
  entry: { track: number; sector: number; index: number };
}

const TYPES = ['DEL', 'SEQ', 'PRG', 'USR', 'REL'] as const;

export const sectorsOn = (track: number): number => (track <= 17 ? 21 : track <= 24 ? 19 : track <= 30 ? 18 : 17);

export class Disk {
  readonly tracks: number;
  readonly bytes: Uint8Array;
  private readonly offsets: number[] = [];

  constructor(image: Uint8Array) {
    const sizes: Record<number, number> = { 174848: 35, 175531: 35, 196608: 40, 197376: 40 };
    const tracks = sizes[image.length];
    if (!tracks) throw new BrokkrError('BRK-E300', `A D64 image is 174848 bytes (35 tracks) or 196608 (40), with or without error bytes; this one is ${image.length}.`);
    this.tracks = tracks;
    this.bytes = image.slice();
    let off = 0;
    for (let t = 1; t <= tracks; t++) { this.offsets[t] = off; off += sectorsOn(t) * 256; }
  }

  /** An empty, formatted 35-track disk. */
  static format(name: string, id = '00'): Disk {
    const d = new Disk(new Uint8Array(174848));
    const b = d.sector(18, 0);
    b.set([18, 1, 0x41, 0]);
    for (let t = 1; t <= 35; t++) {
      const n = sectorsOn(t);
      b[4 * t] = n;
      for (let s = 0; s < n; s++) b[4 * t + 1 + (s >> 3)] |= 1 << (s & 7);
    }
    b.fill(0xa0, 0x90, 0xab);
    b.set(toPetscii(name).subarray(0, 16), 0x90);
    b.set(toPetscii(id).subarray(0, 2), 0xa2);
    b.set([0x32, 0x41], 0xa5);
    d.mark(18, 0, false);
    d.mark(18, 1, false);
    d.sector(18, 1)[1] = 0xff;
    return d;
  }

  sector(track: number, sector: number): Uint8Array {
    if (track < 1 || track > this.tracks || sector < 0 || sector >= sectorsOn(track)) {
      throw new BrokkrError('BRK-E301', `Track ${track} sector ${sector} is not on the disk.`);
    }
    const at = this.offsets[track] + sector * 256;
    return this.bytes.subarray(at, at + 256);
  }

  private get bam(): Uint8Array { return this.sector(18, 0); }

  /** the disk's name and id as the directory header shows them */
  get title(): { name: string; id: string } {
    const b = this.bam;
    return { name: petscii(b.subarray(0x90, 0xa0)), id: petscii(b.subarray(0xa2, 0xa7)) };
  }

  isFree(track: number, sector: number): boolean {
    if (track > 35) return false;
    const b = this.bam, at = 4 * track;
    return (b[at + 1 + (sector >> 3)] & (1 << (sector & 7))) !== 0;
  }

  private mark(track: number, sector: number, free: boolean): void {
    if (track > 35) return;
    const b = this.bam, at = 4 * track, bit = 1 << (sector & 7), i = at + 1 + (sector >> 3);
    if (free === ((b[i] & bit) !== 0)) return;
    if (free) { b[i] |= bit; b[at]++; } else { b[i] &= ~bit; b[at]--; }
  }

  /** blocks free on tracks 1-35 but the directory's, as the 1541 counts them */
  get free(): number {
    let n = 0;
    for (let t = 1; t <= 35; t++) if (t !== 18) n += this.bam[4 * t];
    return n;
  }

  private chain(track: number, sector: number, what: string): { track: number; sector: number }[] {
    const out: { track: number; sector: number }[] = [];
    const seen = new Set<number>();
    while (track !== 0) {
      const key = track * 256 + sector;
      if (seen.has(key)) throw new BrokkrError('BRK-E302', `The ${what} goes round in a circle at track ${track} sector ${sector}.`);
      seen.add(key);
      out.push({ track, sector });
      const s = this.sector(track, sector);
      track = s[0]; sector = s[1];
    }
    return out;
  }

  files(): DiskFile[] {
    const out: DiskFile[] = [];
    for (const { track, sector } of this.chain(18, 1, 'directory')) {
      const s = this.sector(track, sector);
      for (let i = 0; i < 8; i++) {
        const e = s.subarray(i * 32, i * 32 + 32);
        const t = e[2];
        if ((t & 7) > 4 || (t === 0 && e[3] === 0)) continue;
        if ((t & 0x80) === 0 && (t & 7) === 0) continue;
        out.push({
          name: petscii(e.subarray(5, 21)), type: TYPES[t & 7], closed: (t & 0x80) !== 0, locked: (t & 0x40) !== 0,
          track: e[3], sector: e[4], blocks: e[30] | (e[31] << 8), entry: { track, sector, index: i },
        });
      }
    }
    return out;
  }

  find(name: string): DiskFile | null {
    const want = name.toLowerCase();
    return this.files().find(f => f.name.toLowerCase() === want) ?? this.files().find(f => matches(f.name, name)) ?? null;
  }

  read(f: Pick<DiskFile, 'track' | 'sector' | 'name'>): Uint8Array {
    const out: number[] = [];
    for (const { track, sector } of this.chain(f.track, f.sector, `file "${f.name}"`)) {
      const s = this.sector(track, sector);
      const used = s[0] === 0 ? Math.max(1, s[1]) : 256;
      for (let i = 2; i < used + (s[0] === 0 ? 1 : 0) && i < 256; i++) out.push(s[i]);
    }
    return Uint8Array.from(out);
  }

  /** Free a file's blocks and its directory entry. */
  delete(f: DiskFile): void {
    for (const { track, sector } of this.chain(f.track, f.sector, `file "${f.name}"`)) this.mark(track, sector, true);
    const s = this.sector(f.entry.track, f.entry.sector);
    s[f.entry.index * 32 + 2] = 0;
  }

  /** the next free sector for a file: tracks out from the directory, every `interleave` sectors on a track */
  private allocate(near: { track: number; sector: number } | null, interleave = 10): { track: number; sector: number } {
    const order: number[] = [];
    for (let d = 1; d <= 34; d++) { if (18 - d >= 1) order.push(18 - d); if (18 + d <= 35) order.push(18 + d); }
    const tracks = near ? [near.track, ...order.filter(t => t !== near.track)] : order;
    for (const t of tracks) {
      const n = sectorsOn(t);
      const first = near && t === near.track ? (near.sector + interleave) % n : 0;
      for (let k = 0; k < n; k++) {
        const s = (first + k) % n;
        if (this.isFree(t, s)) { this.mark(t, s, false); return { track: t, sector: s }; }
      }
    }
    throw new BrokkrError('BRK-E310', 'The disk is full.', 'Make room by deleting files, or write to a new disk image.');
  }

  /** A free directory entry, adding a directory sector on track 18 when all are used. */
  private entrySlot(): { track: number; sector: number; index: number } {
    const chain = this.chain(18, 1, 'directory');
    for (const { track, sector } of chain) {
      const s = this.sector(track, sector);
      for (let i = 0; i < 8; i++) if (s[i * 32 + 2] === 0) return { track, sector, index: i };
    }
    const last = chain[chain.length - 1];
    const n = sectorsOn(18);
    for (let k = 1; k < n; k++) {
      const sec = (last.sector + 3 * k) % n;
      if (sec === 0 || !this.isFree(18, sec)) continue;
      this.mark(18, sec, false);
      const prev = this.sector(last.track, last.sector);
      prev[0] = 18; prev[1] = sec;
      const s = this.sector(18, sec);
      s.fill(0);
      s[1] = 0xff;
      return { track: 18, sector: sec, index: 0 };
    }
    throw new BrokkrError('BRK-E311', 'The directory is full (144 files).', 'Delete a file or write to a new disk image.');
  }

  /** Write a file (PRG unless said), in place of one with the same name when `replace`. */
  write(name: string, data: Uint8Array, o: { replace?: boolean; type?: DiskFile['type'] } = {}): DiskFile {
    if (!data.length) throw new BrokkrError('BRK-E312', `"${name}" is empty; a file on a disk has at least one byte.`);
    const pet = toPetscii(name);
    if (pet.length > 16) throw new BrokkrError('BRK-E313', `"${name}" is longer than 16 characters, the most a file name on a disk has.`);
    const old = this.files().find(f => f.name === petscii(pet));
    if (old && !o.replace) throw new BrokkrError('BRK-E314', `There is already a file "${old.name}" on the disk.`, 'Replace it, or give the new file another name.');
    const blocks = Math.ceil(data.length / 254);
    if (blocks > this.free + (old ? old.blocks : 0)) {
      throw new BrokkrError('BRK-E310', `"${name}" needs ${blocks} blocks and the disk has ${this.free + (old ? old.blocks : 0)} free.`, 'Make room, or write to a new disk image.');
    }
    const slot = old ? old.entry : null;
    if (old) this.delete(old);
    const entry = slot ?? this.entrySlot();
    const where: { track: number; sector: number }[] = [];
    for (let b = 0; b < blocks; b++) where.push(this.allocate(where[b - 1] ?? null));
    where.forEach((w, b) => {
      const s = this.sector(w.track, w.sector);
      s.fill(0);
      const part = data.subarray(b * 254, b * 254 + 254);
      if (b < blocks - 1) { s[0] = where[b + 1].track; s[1] = where[b + 1].sector; } else { s[0] = 0; s[1] = part.length + 1; }
      s.set(part, 2);
    });
    const es = this.sector(entry.track, entry.sector);
    const e = es.subarray(entry.index * 32, entry.index * 32 + 32);
    e.fill(0, 2);
    e[2] = 0x80 | TYPES.indexOf(o.type ?? 'PRG');
    e[3] = where[0].track; e[4] = where[0].sector;
    e.fill(0xa0, 5, 21);
    e.set(pet, 5);
    e[30] = blocks & 0xff; e[31] = blocks >> 8;
    return this.files().find(f => f.entry.track === entry.track && f.entry.sector === entry.sector && f.entry.index === entry.index)!;
  }
}

/** PETSCII to text: letters and digits as they print in upper case, others as \xNN-like placeholders kept readable. */
export function petscii(b: Uint8Array): string {
  let s = '';
  for (const c of b) {
    if (c === 0xa0) break;
    if (c >= 0x20 && c < 0x5b) s += String.fromCharCode(c);
    else if (c >= 0xc1 && c <= 0xda) s += String.fromCharCode(c - 0x80);
    else s += String.fromCharCode(0x2400 + (c & 0xff));
  }
  return s;
}

function toPetscii(name: string): Uint8Array {
  return Uint8Array.from([...name.toUpperCase()].map(ch => {
    const c = ch.codePointAt(0)!;
    if (c >= 0x2400 && c <= 0x24ff) return c - 0x2400;
    return c < 0x80 ? c : 0x3f;
  }));
}

/** The 1541's wildcards: * ends a name, ? is any one character. */
function matches(name: string, pattern: string): boolean {
  const n = name.toUpperCase(), p = pattern.toUpperCase();
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*') return true;
    if (i >= n.length || (p[i] !== '?' && p[i] !== n[i])) return false;
  }
  return n.length === p.length;
}
