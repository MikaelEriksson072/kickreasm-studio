/* Reading a D64 image the way the 1541's DOS lays it out: the directory on track 18 and a file's sector chain. Used
 * to pick the file to unpack from a disk; the drive itself reads the disk through its own DOS (drive.ts). */
import { sectorsOn } from './gcr.ts';

export interface D64Entry {
  /** the name as the directory lists it (shift-space padding dropped) */
  name: string;
  /** DEL, SEQ, PRG, USR or REL */
  type: string;
  track: number;
  sector: number;
  blocks: number;
}

const TYPES = ['DEL', 'SEQ', 'PRG', 'USR', 'REL'];

function sectorOffset(d64: Uint8Array, track: number, sector: number): number {
  const tracks = d64.length >= 205312 ? 42 : d64.length >= 196608 ? 40 : 35;
  if (track < 1 || track > tracks || sector >= sectorsOn(track)) throw new Error(`track ${track} sector ${sector} is not on the disk`);
  let n = 0;
  for (let t = 1; t < track; t++) n += sectorsOn(t);
  return (n + sector) * 256;
}

const petscii = (bytes: Uint8Array): string =>
  Array.from(bytes, b => (b === 0xa0 ? '' : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b >= 0xc1 && b <= 0xda ? String.fromCharCode(b - 0x80) : '?')).join('');

/** The files in the directory, in its order (closed files only). */
export function d64Directory(d64: Uint8Array): D64Entry[] {
  const out: D64Entry[] = [];
  const seen = new Set<number>();
  let t = 18, s = 1;
  while (t !== 0 && !seen.has(t * 256 + s)) {
    seen.add(t * 256 + s);
    const o = sectorOffset(d64, t, s);
    for (let k = 0; k < 8; k++) {
      const e = o + k * 32, type = d64[e + 2];
      if (!(type & 0x80) || (type & 7) > 4) continue;
      out.push({ name: petscii(d64.subarray(e + 5, e + 21)), type: TYPES[type & 7], track: d64[e + 3], sector: d64[e + 4], blocks: d64[e + 30] | (d64[e + 31] << 8) });
    }
    t = d64[o]; s = d64[o + 1];
  }
  return out;
}

/** A file's bytes, following its sector chain (a PRG with its load address first). */
export function d64File(d64: Uint8Array, entry: Pick<D64Entry, 'track' | 'sector'>): Uint8Array {
  const parts: number[] = [];
  const seen = new Set<number>();
  let t = entry.track, s = entry.sector;
  while (t !== 0) {
    if (seen.has(t * 256 + s)) throw new Error(`the file's sector chain loops at track ${t} sector ${s}`);
    seen.add(t * 256 + s);
    const o = sectorOffset(d64, t, s);
    const next = d64[o], last = d64[o + 1];
    parts.push(...d64.subarray(o + 2, next === 0 ? o + Math.max(2, last + 1) : o + 256));
    t = next; s = last;
  }
  return Uint8Array.from(parts);
}

/** The first PRG in the directory, or the one named (`*` and `?` as the DOS takes them). */
export function d64Pick(d64: Uint8Array, name?: string): D64Entry | null {
  const files = d64Directory(d64).filter(e => e.type === 'PRG' && e.track);
  if (!name) return files[0] ?? null;
  const re = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.').replace(/\*.*$/, '.*')}${name.includes('*') ? '' : '$'}`);
  return files.find(e => re.test(e.name)) ?? null;
}
