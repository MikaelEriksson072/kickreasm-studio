/* 1541 disk images (.d64): the directory, free blocks, and the files' bytes along their sector chains.
 * 35, 40 and 42 tracks, with or without the error byte per sector that some images append. */

export type D64FileType = 'DEL' | 'SEQ' | 'PRG' | 'USR' | 'REL';

export interface D64File {
  /** the name as shown in a directory listing (PETSCII to text; trailing shift-spaces dropped) */
  name: string;
  /** the 16 name bytes as stored, $a0-padded */
  raw: Uint8Array;
  type: D64FileType;
  /** false: a "splat" file (`*PRG`) that was never closed */
  closed: boolean;
  locked: boolean;
  /** size in blocks, as the directory says */
  blocks: number;
  /** first sector of the file */
  track: number; sector: number;
}

export interface D64Image {
  name: string; id: string; dosType: string;
  tracks: 35 | 40 | 42;
  /** the image has an error byte per sector after the data */
  errorInfo: boolean;
  /** "blocks free" as the 1541 counts them (tracks 1-35 without the directory track) */
  freeBlocks: number;
  files: D64File[];
}

const TYPES: (D64FileType | null)[] = ['DEL', 'SEQ', 'PRG', 'USR', 'REL', null, null, null];
const SIZES: Record<number, { tracks: 35 | 40 | 42; errorInfo: boolean }> = {
  174848: { tracks: 35, errorInfo: false }, 175531: { tracks: 35, errorInfo: true },
  196608: { tracks: 40, errorInfo: false }, 197376: { tracks: 40, errorInfo: true },
  205312: { tracks: 42, errorInfo: false }, 206114: { tracks: 42, errorInfo: true },
};
const DIR_TRACK = 18;

export const sectorsOnTrack = (t: number): number => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);

/** The offset of a sector in an image of `tracks` tracks (without error bytes). */
export function sectorOffset(t: number, s: number, tracks: number): number {
  if (t < 1 || t > tracks || s < 0 || s >= sectorsOnTrack(t)) throw new Error(`track ${t} sector ${s} is not on the disk`);
  let n = 0;
  for (let i = 1; i < t; i++) n += sectorsOnTrack(i);
  return (n + s) * 256;
}

const sizeInfo = (u8: Uint8Array) => {
  const info = SIZES[u8.length];
  if (!info) throw new Error(`not a .d64 disk image: ${u8.length} bytes (a 35-track image has 174848)`);
  return info;
};

/** PETSCII name bytes to text: letters, digits and punctuation as they look in upper case mode, other codes as `·`. */
export function petsciiName(raw: Uint8Array): string {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0xa0) end--;
  let s = '';
  for (let i = 0; i < end; i++) {
    const b = raw[i];
    s += b >= 0x20 && b <= 0x5b ? String.fromCharCode(b) : b === 0x5d ? ']' : b === 0x5c ? '£' : b === 0x5e ? '↑' : b === 0x5f ? '←'
      : b === 0xa0 ? ' ' : (b >= 0xc1 && b <= 0xda) || (b >= 0x61 && b <= 0x7a) ? String.fromCharCode((b & 0x1f) + 0x60) : '·';
  }
  return s;
}

/** Read the directory of a .d64 image. */
export function parseD64(u8: Uint8Array): D64Image {
  const { tracks, errorInfo } = sizeInfo(u8);
  const bam = u8.subarray(sectorOffset(DIR_TRACK, 0, tracks), sectorOffset(DIR_TRACK, 0, tracks) + 256);
  let freeBlocks = 0;
  for (let t = 1; t <= 35; t++) if (t !== DIR_TRACK) freeBlocks += bam[4 * t];
  const files: D64File[] = [];
  const seen = new Set<number>();
  // the BAM points at the first directory sector; 18/1 when the link is broken
  let t = bam[0] === DIR_TRACK ? bam[0] : DIR_TRACK, s = bam[0] === DIR_TRACK && bam[1] < sectorsOnTrack(DIR_TRACK) ? bam[1] : 1;
  while (t !== 0) {
    const off = sectorOffset(t, s, tracks);
    if (seen.has(off)) break; // a loop in the directory chain
    seen.add(off);
    for (let e = 0; e < 8; e++) {
      const p = off + e * 32, kind = u8[p + 2];
      if (kind === 0) continue; // an empty or scratched entry
      const type = TYPES[kind & 7];
      if (!type) continue;
      const raw = u8.slice(p + 5, p + 21);
      files.push({ name: petsciiName(raw), raw, type, closed: !!(kind & 0x80), locked: !!(kind & 0x40), blocks: u8[p + 30] | (u8[p + 31] << 8), track: u8[p + 3], sector: u8[p + 4] });
    }
    [t, s] = [u8[off], u8[off + 1]];
    if (t !== 0 && (t > tracks || s >= sectorsOnTrack(t))) break; // a broken link ends the listing
  }
  const text = (a: number, n: number) => petsciiName(u8.subarray(sectorOffset(DIR_TRACK, 0, tracks) + a, sectorOffset(DIR_TRACK, 0, tracks) + a + n));
  return { name: text(0x90, 16), id: text(0xa2, 2), dosType: text(0xa5, 2), tracks, errorInfo, freeBlocks, files };
}

/** The bytes of a file (for a PRG, its load address first), following its sector chain. */
export function readD64File(u8: Uint8Array, f: Pick<D64File, 'name' | 'track' | 'sector'>): Uint8Array {
  const { tracks } = sizeInfo(u8);
  const parts: Uint8Array[] = [];
  const seen = new Set<number>();
  let t = f.track, s = f.sector, n = 0;
  if (t === 0) throw new Error(`"${f.name}" has no data on the disk`);
  while (t !== 0) {
    const off = sectorOffset(t, s, tracks);
    if (seen.has(off)) throw new Error(`"${f.name}": its sector chain loops back to track ${t} sector ${s}`);
    seen.add(off);
    const [nt, ns] = [u8[off], u8[off + 1]];
    // the last sector: the second byte is the index of its last used byte
    const end = nt === 0 ? Math.max(1, ns) + 1 : 256;
    parts.push(u8.subarray(off + 2, off + end));
    n += end - 2;
    [t, s] = [nt, ns];
  }
  const out = new Uint8Array(n);
  let p = 0;
  for (const x of parts) { out.set(x, p); p += x.length; }
  return out;
}

/** A host file name for a disk file: the name with characters Windows does not allow replaced, plus `.prg` for programs. */
export function d64FileName(f: Pick<D64File, 'name' | 'type'>): string {
  // eslint-disable-next-line no-control-regex
  const base = f.name.replace(/[<>:"/\\|?*\u0000-\u001f·]/g, '_').replace(/[. ]+$/, '').trim() || 'file';
  return `${base}.${f.type.toLowerCase()}`;
}

/**
 * Write a 35-track image with these files (closed, one after another from track 1, skipping the directory track).
 * Names are taken as PETSCII upper case (ASCII letters, digits, punctuation).
 */
export function makeD64(o: { name: string; id?: string; files: { name: string; type?: D64FileType; data: Uint8Array }[] }): Uint8Array {
  const tracks = 35, u8 = new Uint8Array(174848);
  const used = new Set<string>();
  const bamOff = sectorOffset(DIR_TRACK, 0, tracks);
  const petscii = (s: string, n: number) => { const b = new Uint8Array(n).fill(0xa0); for (let i = 0; i < Math.min(n, s.length); i++) b[i] = s.toUpperCase().charCodeAt(i) & 0x7f; return b; };
  const take = (t: number, s: number) => { used.add(`${t}/${s}`); return sectorOffset(t, s, tracks); };
  let ft = 1, fs = 0;
  const nextData = (): [number, number] => {
    for (;;) {
      if (ft === DIR_TRACK) { ft++; fs = 0; }
      if (ft > tracks) throw new Error('the files do not fit on a 35-track disk');
      if (fs < sectorsOnTrack(ft)) return [ft, fs++];
      ft++; fs = 0;
    }
  };
  // directory sectors 18/1, 18/4, 18/7 …: 8 entries each
  const dirSectors: number[] = [];
  for (let i = 0; i < Math.max(1, Math.ceil(o.files.length / 8)); i++) dirSectors.push(1 + 3 * i);
  if (dirSectors[dirSectors.length - 1] >= sectorsOnTrack(DIR_TRACK)) throw new Error('too many files for the directory track');
  o.files.forEach((f, i) => {
    const chain: [number, number][] = [];
    for (let p = 0; p === 0 || p < f.data.length; p += 254) chain.push(nextData());
    chain.forEach(([t, s], k) => {
      const off = take(t, s), part = f.data.subarray(k * 254, k * 254 + 254);
      if (k + 1 < chain.length) { u8[off] = chain[k + 1][0]; u8[off + 1] = chain[k + 1][1]; } else { u8[off] = 0; u8[off + 1] = part.length + 1; }
      u8.set(part, off + 2);
    });
    const d = take(DIR_TRACK, dirSectors[i >> 3]) + (i & 7) * 32;
    u8[d + 2] = 0x80 | TYPES.indexOf(f.type ?? 'PRG');
    u8[d + 3] = chain[0][0]; u8[d + 4] = chain[0][1];
    u8.set(petscii(f.name, 16), d + 5);
    u8[d + 30] = chain.length & 0xff; u8[d + 31] = chain.length >> 8;
  });
  dirSectors.forEach((s, i) => {
    const off = take(DIR_TRACK, s);
    if (i + 1 < dirSectors.length) { u8[off] = DIR_TRACK; u8[off + 1] = dirSectors[i + 1]; } else { u8[off] = 0; u8[off + 1] = 0xff; }
  });
  take(DIR_TRACK, 0);
  u8[bamOff] = DIR_TRACK; u8[bamOff + 1] = 1; u8[bamOff + 2] = 0x41;
  for (let t = 1; t <= tracks; t++) {
    let free = 0, bits = 0;
    for (let s = 0; s < sectorsOnTrack(t); s++) if (!used.has(`${t}/${s}`)) { free++; bits |= 1 << s; }
    u8[bamOff + 4 * t] = free; u8[bamOff + 4 * t + 1] = bits & 0xff; u8[bamOff + 4 * t + 2] = (bits >> 8) & 0xff; u8[bamOff + 4 * t + 3] = bits >> 16;
  }
  u8.set(petscii(o.name, 16), bamOff + 0x90);
  u8[bamOff + 0xa0] = 0xa0; u8[bamOff + 0xa1] = 0xa0;
  u8.set(petscii(o.id ?? '01', 2), bamOff + 0xa2);
  u8[bamOff + 0xa4] = 0xa0; u8[bamOff + 0xa5] = 0x32; u8[bamOff + 0xa6] = 0x41;
  for (let i = 0xa7; i <= 0xaa; i++) u8[bamOff + i] = 0xa0;
  return u8;
}
