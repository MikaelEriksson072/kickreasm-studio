/* A writer for Spindle 3 disks, to test the reader with (c64/spindle-disk.ts): the layout of Spindle 3.1's disk.c and
 * the units of pack.c, written the simple way. The boot program holds only what the reader looks for: the start of
 * Spindle's resident page and the jump to the loader with the address to go on at; nothing of Spindle's own code. */
const SIZES = (t: number) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
const scramble = (i: number) => (i & 1 ? 0 : 8) | (i & 2 ? 0 : 2) | (i & 4 ? 0 : 4) | (i & 8 ? 0 : 1) | (i & 0x10 ? 0 : 0x10) | (i & 0x20 ? 0 : 0x20) | (i & 0x40 ? 0 : 0x40) | (i & 0x80);

export interface FakeJob {
  chunks: { start: number; bytes: number[] }[];
  labels?: number[];
  /** a jmp the loader makes after the job (Pefchain's side door) */
  jump?: number;
  /** patch the loader's page (as pack.c does to turn shadow RAM on and off) */
  patch?: boolean;
  /** the first unit fills a whole sector (its first byte has 0x80) */
  full?: boolean;
}

/** Items for `bytes` at `start`: copies of 2 (from up to 127 higher) and 3-18 bytes (up to 1024 higher), else literals. */
function units(start: number, bytes: number[], full: boolean): number[][] {
  const items: { pos: number; b: number[] }[] = [];
  let lit: number[] = [], litAt = 0;
  const flush = () => { if (lit.length) items.push({ pos: litAt, b: [0xc0 | (lit.length - 1), ...lit] }); lit = []; };
  for (let i = 0; i < bytes.length;) {
    let best = 0, off = 0;
    if (!full) for (let o = 1; o <= 1024 && i + o < bytes.length; o++) {
      let n = 0;
      while (n < 18 && i + n < bytes.length && i + o + n < bytes.length && bytes[i + n] === bytes[i + o + n]) n++;
      if (n > best && (n >= 3 || o <= 127)) { best = n; off = o; }
    }
    if (best >= 3) { flush(); items.push({ pos: i, b: [0x80 | ((best - 3) << 2) | ((off - 1) >> 8), (off - 1) & 0xff] }); i += best; continue; }
    if (best === 2) { flush(); items.push({ pos: i, b: [off] }); i += 2; continue; }
    if (!lit.length) litAt = i;
    lit.push(bytes[i++]);
    if (lit.length === 64 || (full && items.length === 3 && lit.length === 56)) flush();
  }
  flush();
  // units of at most 200 bytes, the first one exactly 255 when it should fill a sector
  const out: number[][] = [];
  for (let k = 0; k < items.length;) {
    const max = full && !out.length ? 255 : 200, u = [(start + items[k].pos) >> 8, (start + items[k].pos) & 0xff, 0];
    while (k < items.length && u.length + items[k].b.length <= max) u.push(...items[k++].b);
    out.push(u);
  }
  return out;
}

export function makeSpindleDisk(jobs: FakeJob[], o: { start?: number; resident?: number; knock?: number; next?: number; perBatch?: number } = {}): Uint8Array {
  const tracks = 35, image = new Uint8Array(174848);
  const off = (t: number, s: number) => { let n = 0; for (let i = 1; i < t; i++) n += SIZES(i); return (n + s) * 256; };
  const sec = (t: number, s: number) => image.subarray(off(t, s), off(t, s) + 256);
  const res = o.resident ?? 2, start = o.start ?? 0x0800;
  // the boot program at 18/8: a BASIC line, the resident page's first bytes, and lda #>start-1 / pha / lda #<start-1 /
  // pha / jmp $0200
  const boot = [0x01, 0x08, 0x0b, 0x08, 0x01, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0, 0, 0,
    0xa9, (start - 1) >> 8, 0x48, 0xa9, (start - 1) & 0xff, 0x48, 0x4c, 0x00, res, 0xa9, 0x18, 0x80, 0x01, 0xc9, 0x38];
  sec(18, 8).set([0, boot.length + 1, ...boot]);
  // the BAM's name and the directory's one entry, "DEMO" at 18/8, as Spin writes them
  const pet = (s: string, n: number) => [...s.toUpperCase().padEnd(n, '\xa0')].map(c => c.charCodeAt(0));
  sec(18, 0).set([18, 1, 0x41]);
  sec(18, 0).set([...pet('SPINDLE DEMO', 18), ...pet('MI', 2), 0xa0, 0x32, 0x41], 0x90);
  sec(18, 1).set([0, 0xff, 0x82, 18, 8, ...pet('DEMO', 16)]);
  sec(18, 1)[30] = 1;
  // the sectors of each batch, a batch at most `perBatch` sectors on one track
  let track = 1, used = 0;
  const per = o.perBatch ?? 4;
  interface Batch { track: number; nums: number[]; newTrack: boolean; newJob: boolean; records: number[][]; full: number[] | null }
  const batches: Batch[] = [];
  const seekpoints = new Map<number, number>();
  jobs.forEach((j, ji) => {
    const recs: number[][] = [];
    for (const c of j.chunks) recs.push(...units(c.start, c.bytes, !!j.full));
    if (j.jump != null) recs.push([j.jump >> 8, j.jump & 0xff, 0x4c]);
    if (j.patch) recs.push([res, 0x12, 0x00, 0xc0, 0xe6]);
    let first = true, full = j.full ? recs.shift()! : null;
    while (recs.length || full) {
      let newTrack = false;
      if (used + per > SIZES(track)) { track++; if (track === 18) track++; used = 0; newTrack = true; }
      const nums = [...Array(per).keys()].map(k => used + k);
      used += per;
      if (first) for (const l of j.labels ?? []) seekpoints.set(l, batches.length);
      const b: Batch = { track, nums, newTrack, newJob: first && ji > 0, records: [], full };
      batches.push(b);
      // fill the batch's sectors: the first holds the next record at 253, so it has 252 bytes; a full unit takes the second
      const room = nums.map((_, k) => (k === 0 ? 252 : k === 1 && full ? 0 : 255));
      full = null;
      for (let k = 0; k < nums.length && recs.length; k++) {
        while (recs.length && recs[0].length + 1 <= room[k]) { room[k] -= recs[0].length + 1; b.records.push([k, ...recs.shift()!]); }
      }
      first = false;
    }
  });
  // the chain records: the first in 18/17 at 253, then each in the first sector of the batch before
  const record = (b: Batch | null) => {
    if (!b) return [0xa0, 0x80, 0x00];
    const r = [(b.newJob ? 0x80 : 0) | (b.newTrack ? 0x40 : 0), 0, 0];
    for (const n of b.nums) { if (n < 5) r[0] |= 0x10 >> n; else if (n < 13) r[1] |= 0x80 >> (n - 5); else r[2] |= 0x80 >> (n - 13); }
    return r;
  };
  const where: [number, number][] = [[18, 17]];
  sec(18, 17).set(record(batches[0]), 253);
  batches.forEach((b, i) => {
    const s = b.nums.map(n => sec(b.track, n));
    s[0][0] |= 0x40;
    s[0].set(record(batches[i + 1] ?? null), 253);
    where.push([b.track, b.nums[0]]);
    // a full unit goes in the second sector (the first holds the record)
    const tops: number[] = s.map((_, k) => (k === 0 ? 252 : 255));
    if (b.full) { s[1][0] |= 0x80; s[1].set(b.full.map(scramble), 1); tops[1] = 0; }
    for (const [k, ...r] of b.records) {
      const top = tops[k];
      s[k][top] = r.length;
      s[k].set(r.map(scramble), top - r.length);
      tops[k] = top - r.length - 1;
    }
  });
  // every sector's first byte has its number (not on track 18), and a padding copy of the first data sector
  for (let t = 1; t <= tracks; t++) if (t !== 18) for (let s = 0; s < SIZES(t); s++) sec(t, s)[0] |= s;
  const b0 = batches[0];
  sec(b0.track, SIZES(b0.track) - 1).set(sec(b0.track, b0.nums[0]));
  // the seek table at 18/6, backwards: each label's chain record, an unused one the end
  const seek = sec(18, 6), end = where[where.length - 1];
  for (let l = 0; l < 64; l++) {
    const bi = seekpoints.get(l), [t, s] = bi != null ? where[bi] : end;
    seek[(0x80 - l) & 0xff] = t * 2; seek[(0x40 - l) & 0xff] = s;
  }
  const knock = o.knock ?? 0x54464c;
  sec(18, 17).set([knock >> 16, (knock >> 8) & 0xff, knock & 0xff], 0xf9);
  if (o.next) sec(18, 5).set([o.next >> 16, (o.next >> 8) & 0xff, o.next & 0xff], 1);
  return image;
}
