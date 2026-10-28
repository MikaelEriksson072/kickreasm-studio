/* The load script of a Spindle 3 disk (spec 13.5b). Spin, Spindle's disk builder, reads a script with a paragraph per
 * loader call (a job): the files to load, each with its address, offset and length, and `NN:` labels to seek to. The
 * script is not on the disk, but its jobs are: Spin crunches each job and stores it in sector batches that the drive
 * reads in any order. Reading the batches back and decrunching them gives every job's chunks, the bytes it loads and
 * where; the file names are not on the disk.
 *
 * The format is Spindle 3.0's and 3.1's (disk.c, pack.c and stage1.s; MIT licence):
 * - track 18 holds the boot program (18/8, 18/18, 18/9, 18/15), the drive code and, in 18/17 at 253, the first chain
 *   record; a seek table of labels is in 18/6;
 * - a chain record is 3 bytes: flags (0x80 a new job, 0x40 on the next track, 0x20 the end of the side) and a bit per
 *   sector number (0-4 in the first byte, 5-12 and 13-20 in the others) of the sectors that make up the next batch;
 *   one of those holds the next record at 253;
 * - a sector's first byte is its number (padding copies of a sector keep it) with 0x40 when it holds the next record
 *   and 0x80 when one unit fills it; the rest are records from the top down, each its bytes followed by its length;
 * - a unit is a destination (high byte first), a link the decruncher uses, then items: `11llllll` and l+1 literal
 *   bytes, `10llllhh oooooooo` a copy of l+3 bytes from o+1 bytes higher, `0ooooooo` a copy of 2 bytes from o higher.
 *   Its bytes are scrambled for the serial bus (`scramble_bits`). Records of 2 bytes are chain heads, of 3 a jump the
 *   loader makes after the job (`jmp`, Pefchain's side door), units into the loader's page patch it (shadow RAM).
 * Copies come from higher addresses, so a job decrunches from its highest byte down. */
import type { Addr } from '../types';
import { sectorOffset } from './d64';

export interface SpindleChunk { start: Addr; end: Addr; bytes: Uint8Array }

export interface SpindleJob {
  /** its number, from 1 (the boot program makes the first loader call) */
  n: number;
  /** the labels (00-3f) a seek goes to it with */
  labels: number[];
  /** where its chain record is: 18/17 for the first job */
  track: number; sector: number;
  /** what it loads, by address */
  chunks: SpindleChunk[];
  /** the address the loader jumps to after the job (Pefchain's side door); null: it returns */
  jump: Addr | null;
  /** it loads under the I/O area ($d000-$dfff, shadow RAM) */
  shadow: boolean;
  /** bytes a copy needs that nothing in the job has (a damaged disk) */
  missing: number;
}

export interface SpindleDisk {
  jobs: SpindleJob[];
  /** where the boot program goes after the first job (spin -e) */
  start: Addr | null;
  /** the loader's page (spin -r, $02 by default) */
  resident: number;
  /** the side's knock code (Spin's default is $54464c), and the next side's on all but the last side; null: none */
  knock: number | null; next: number | null;
}

/** pack.c: the bit order of the serial transfer; the disk holds each byte as it is sent */
const SCRAMBLE = Array.from({ length: 256 }, (_, i) => (i & 1 ? 0 : 8) | (i & 2 ? 0 : 2) | (i & 4 ? 0 : 4) | (i & 8 ? 0 : 1) | (i & 0x10 ? 0 : 0x10) | (i & 0x20 ? 0 : 0x20) | (i & 0x40 ? 0 : 0x40) | (i & 0x80));
const UNSCRAMBLE = new Uint8Array(256);
SCRAMBLE.forEach((s, i) => { UNSCRAMBLE[s] = i; });

/** the start of Spindle 3's resident page in the boot program (stage1.s) */
const RESIDENT = [0xa9, 0x18, 0x80, 0x01, 0xc9, 0x38];
const SIZES: Record<number, 35 | 40> = { 174848: 35, 175531: 35, 196608: 40, 197376: 40 };

const indexOf = (b: Uint8Array, p: number[]) => { for (let a = 0; a + p.length <= b.length; a++) if (p.every((x, i) => b[a + i] === x)) return a; return -1; };

/** The jobs of a Spindle 3 disk; null when it is not one. */
export function readSpindleDisk(image: Uint8Array): SpindleDisk | null {
  const tracks = SIZES[image.length];
  if (!tracks) return null;
  const sec = (t: number, s: number) => { const o = sectorOffset(t, s, tracks); return image.subarray(o, o + 256); };
  // the boot program: Spindle 3's resident page, and where it goes after the first job (lda #>a-1 / pha / lda #<a-1 /
  // pha / jmp loader)
  const boot = new Uint8Array([...[8, 18, 9, 15].flatMap(s => [...sec(18, s).subarray(2)])]);
  if (indexOf(boot, RESIDENT) < 0) return null;
  let start: Addr | null = null, resident = 2;
  for (let a = 0; a + 9 <= boot.length; a++) {
    if (boot[a] === 0xa9 && boot[a + 2] === 0x48 && boot[a + 3] === 0xa9 && boot[a + 5] === 0x48 && boot[a + 6] === 0x4c && boot[a + 7] === 0x00) {
      start = (((boot[a + 1] << 8) | boot[a + 4]) + 1) & 0xffff; resident = boot[a + 8]; break;
    }
  }
  // the sectors of a track by the number in their first byte
  const numbered = (t: number) => {
    const m = new Map<number, Uint8Array>();
    for (let s = 0; s < (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17); s++) { const b = sec(t, s); if (!m.has(b[0] & 0x1f)) m.set(b[0] & 0x1f, b); }
    return m;
  };
  interface Raw { track: number; sector: number; units: number[][]; jump: Addr | null }
  const raws: Raw[] = [];
  let rec = sec(18, 17).subarray(253, 256), at: [number, number] = [18, 17], track = 1, job: Raw | null = null;
  for (let batches = 0; ; batches++) {
    if (batches > 2000) return null;
    const flags = rec[0];
    if (flags & 0x20) break; // the end of the side
    if (flags & 0x40 && ++track === 18) track++;
    if (track > tracks) return null;
    if (flags & 0x80 || !job) raws.push(job = { track: at[0], sector: at[1], units: [], jump: null });
    const nums = [...Array(21).keys()].filter(n => (n < 5 ? flags & (0x10 >> n) : n < 13 ? rec[1] & (0x80 >> (n - 5)) : rec[2] & (0x80 >> (n - 13))));
    if (!nums.length) return null;
    const secs = numbered(track);
    let next: [Uint8Array, [number, number]] | null = null;
    for (const n of nums) {
      const b = secs.get(n);
      if (!b) return null;
      if (b[0] & 0x40) next = [b.subarray(253, 256), [track, n]];
      if (b[0] & 0x80) { job.units.push([...b.subarray(1)].map(x => UNSCRAMBLE[x])); continue; }
      for (let p = b[0] & 0x40 ? 252 : 255; p >= 1;) {
        const len = b[p];
        if (!len || len > p - 1) break;
        const r = [...b.subarray(p - len, p)].map(x => UNSCRAMBLE[x]);
        p -= len + 1;
        if (len === 2) continue; // a chain head
        if (len === 3 && r[2] === 0x4c) { job.jump = (r[0] << 8) | r[1]; continue; }
        job.units.push(r);
      }
    }
    if (!next) return null;
    [rec, at] = next;
  }
  // the seek table (18/6, stored backwards): a label's chain record, or the end of the side when it is not used
  const seek = sec(18, 6), labels = new Map<string, number[]>();
  for (let l = 0; l < 64; l++) {
    const key = `${seek[(0x80 - l) & 0xff] >> 1}/${seek[(0x40 - l) & 0xff]}`;
    labels.set(key, [...(labels.get(key) ?? []), l]);
  }
  const jobs = raws.map((r, i): SpindleJob => ({ n: i + 1, labels: labels.get(`${r.track}/${r.sector}`) ?? [], track: r.track, sector: r.sector, jump: r.jump, ...decrunch(r.units, resident) }));
  // the first job has no label of its own when every unused label points elsewhere; a label that all 64 share is none
  for (const j of jobs) if (j.labels.length === 64) j.labels = [];
  const s17 = sec(18, 17), s5 = sec(18, 5);
  const knock = (s17[0xf9] << 16) | (s17[0xfa] << 8) | s17[0xfb], next = (s5[1] << 16) | (s5[2] << 8) | s5[3];
  return { jobs, start, resident, knock: knock || null, next: next || null };
}

/** A job's units decrunched: from its highest byte down, since copies come from higher addresses. */
function decrunch(units: number[][], resident: number): Pick<SpindleJob, 'chunks' | 'shadow' | 'missing'> {
  type Item = { pos: number; n: number; lit: number[] | null; off: number };
  const items: Item[] = [];
  let shadow = false;
  for (const u of units) {
    if (u.length < 3) continue;
    let pos = (u[0] << 8) | u[1];
    // a unit into the loader's page patches it: shadow RAM on or off
    if (pos >> 8 === resident) { shadow = true; continue; }
    for (let i = 3; i < u.length;) {
      const b = u[i];
      if (b >= 0xc0) { const n = (b & 0x3f) + 1; items.push({ pos, n, lit: u.slice(i + 1, i + 1 + n), off: 0 }); i += 1 + n; pos += n; }
      else if (b >= 0x80) { const n = ((b >> 2) & 0x0f) + 3; items.push({ pos, n, lit: null, off: (((b & 3) << 8) | u[i + 1]) + 1 }); i += 2; pos += n; }
      else { items.push({ pos, n: 2, lit: null, off: b }); i += 1; pos += 2; }
    }
  }
  const mem = new Uint8Array(0x10000), known = new Uint8Array(0x10000);
  let missing = 0;
  for (const it of items.sort((x, y) => y.pos - x.pos)) {
    for (let k = it.n - 1; k >= 0; k--) {
      const a = (it.pos + k) & 0xffff;
      if (it.lit) mem[a] = it.lit[k];
      else { const src = (a + it.off) & 0xffff; if (!known[src]) missing++; mem[a] = mem[src]; }
      known[a] = 1;
    }
  }
  const chunks: SpindleChunk[] = [];
  for (let a = 0; a < 0x10000;) {
    if (!known[a]) { a++; continue; }
    let e = a;
    while (e < 0x10000 && known[e]) e++;
    chunks.push({ start: a, end: e, bytes: mem.slice(a, e) });
    a = e;
  }
  if (chunks.some(c => c.start < 0xe000 && c.end > 0xd000)) shadow = true;
  return { chunks, shadow, missing };
}

const hx = (v: number, w: number) => v.toString(16).padStart(w, '0');

/** A chunk's file name in the rebuilt script: the job and the address (the real names are not on the disk). */
export const spinChunkName = (j: SpindleJob, c: SpindleChunk): string => `job${hx(j.n, 2)}_${hx(c.start, 4)}.bin`;

/** The load script as Spin reads it: a paragraph per job, a line per chunk (`name address`), labels as `NN:`. */
export function spinScript(disk: SpindleDisk, name: string): string[] {
  const out = [
    `# Spin load script, rebuilt by Mimir Studio from ${name} (Spindle 3): ${disk.jobs.length} job${disk.jobs.length === 1 ? '' : 's'}.`,
    '# A paragraph is a loader call. The file names are made up: each is the bytes the job loads at that address.',
  ];
  const opts = [disk.start != null ? `-e ${hx(disk.start, 4)}` : null, disk.resident !== 2 ? `-r ${hx(disk.resident, 2)}` : null,
    disk.knock != null && disk.knock !== 0x54464c ? `-m ${hx(disk.knock, 6)}` : null, disk.next != null ? `-n ${hx(disk.next, 6)}` : null].filter(Boolean);
  if (opts.length) out.push(`# spin ${opts.join(' ')}`);
  for (const j of disk.jobs) {
    out.push('');
    for (const l of j.labels) out.push(`${hx(l, 2)}:`);
    const notes = [j.jump != null ? `then jumps to $${hx(j.jump, 4)}` : null, j.missing ? `${j.missing} bytes could not be decrunched` : null].filter(Boolean);
    if (notes.length) out.push(`# job ${j.n}: ${notes.join('; ')}`);
    for (const c of j.chunks) out.push(`${spinChunkName(j, c).padEnd(18)} ${hx(c.start, 4)}    # $${hx(c.start, 4)}-$${hx(c.end - 1, 4)}, ${c.end - c.start} bytes`);
  }
  if (disk.next != null) out.push('', '# then the next disk side');
  return out;
}
