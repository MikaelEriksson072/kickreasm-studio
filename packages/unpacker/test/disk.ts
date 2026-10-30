/* A D64 for the tests: a BAM with the disk's name and ID, a directory, and files and raw sectors where asked. */
import { sectorsOn } from '../src/gcr.ts';

export interface DiskFile { name: string; prg: Uint8Array }
export interface RawSector { track: number; sector: number; bytes: Uint8Array }

const offset = (t: number, s: number): number => { let n = 0; for (let k = 1; k < t; k++) n += sectorsOn(k); return (n + s) * 256; };
const padded = (text: string): number[] => [...text.slice(0, 16)].map(c => c.charCodeAt(0)).concat(Array(16).fill(0xa0)).slice(0, 16);

export function makeD64(files: DiskFile[], raw: RawSector[] = [], name = 'TEST DISK', id = 'UT'): Uint8Array {
  const d64 = new Uint8Array(174848);
  const used = new Set(raw.map(r => r.track * 256 + r.sector));
  for (const r of raw) d64.set(r.bytes.subarray(0, 256), offset(r.track, r.sector));
  let t = 1, s = 0;
  const alloc = (): [number, number] => {
    for (;;) {
      if (t === 18) t++;
      if (s >= sectorsOn(t)) { t++; s = 0; continue; }
      const k = t * 256 + s++;
      if (!used.has(k)) { used.add(k); return [t, s - 1]; }
    }
  };
  const dir = offset(18, 1);
  d64.set([0x00, 0xff], dir);
  files.forEach((f, i) => {
    const sectors: [number, number][] = [];
    for (let k = 0; k < Math.max(1, Math.ceil(f.prg.length / 254)); k++) sectors.push(alloc());
    sectors.forEach(([st, ss], k) => {
      const o = offset(st, ss), part = f.prg.subarray(k * 254, k * 254 + 254), next = sectors[k + 1];
      d64.set(next ? next : [0, part.length + 1], o);
      d64.set(part, o + 2);
    });
    const e = dir + i * 32;
    d64.set([0x82, sectors[0][0], sectors[0][1], ...padded(f.name)], e + 2);
    d64[e + 30] = sectors.length;
  });
  const bam = offset(18, 0);
  d64.set([18, 1, 0x41, 0], bam);
  for (let k = 1; k <= 35; k++) d64.set([sectorsOn(k), 0xff, 0xff, 0x1f], bam + 4 * k);
  d64.set(padded(name), bam + 0x90);
  d64.set([0xa0, 0xa0, id.charCodeAt(0), id.charCodeAt(1), 0xa0, 0x32, 0x41, 0xa0, 0xa0, 0xa0, 0xa0], bam + 0xa0);
  return d64;
}
