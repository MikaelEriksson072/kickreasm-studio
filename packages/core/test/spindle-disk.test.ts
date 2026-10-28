/* The load script of a Spindle 3 disk (c64/spindle-disk.ts, spec 13.5b), read from disks that test/helpers/spindle-disk.ts
 * writes the way Spindle 3.1's disk.c and pack.c do. The reader was also checked against disks spin.exe and
 * pefchain.exe 3.1 built (every chunk byte-identical with its file) and the four sides of a released trackmo. */
import { describe, expect, it } from 'vitest';
import { makeD64, parseD64, readSpindleDisk, spinChunkName, spinScript, type SpindleDisk } from '../src';
import { makeSpindleDisk, type FakeJob } from './helpers/spindle-disk';

// a program, a repeated pattern (copies of 2 and of 3-18 bytes), and data under the I/O area
const CODE = [0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x20, 0x00, 0x02, 0x4c, 0x08, 0x08];
const PATTERN = Array.from({ length: 600 }, (_, i) => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10][i % 10] ^ (i >> 7));
const NOISE = (n: number, seed: number) => Array.from({ length: n }, (_, i) => (i * 73 + seed * 29 + ((i * i) >> 3)) & 0xff);
const JOBS: FakeJob[] = [
  { chunks: [{ start: 0x0800, bytes: CODE }, { start: 0x1000, bytes: PATTERN }] },
  { labels: [1], chunks: [{ start: 0x4000, bytes: NOISE(700, 1) }, { start: 0x6000, bytes: PATTERN.slice(0, 300) }] },
  { labels: [2, 0x1f], full: true, chunks: [{ start: 0x2000, bytes: NOISE(400, 2) }] },
  { patch: true, jump: 0x307a, chunks: [{ start: 0xcf00, bytes: NOISE(0x200, 3) }] },
];
const read = (jobs = JOBS, o = {}): SpindleDisk => readSpindleDisk(makeSpindleDisk(jobs, o))!;

describe('Spindle 3 disks', () => {
  it('read every job: its chunks, decrunched from their highest byte down, byte for byte', () => {
    const d = read();
    expect(d).toMatchObject({ start: 0x0800, resident: 2, knock: 0x54464c, next: null });
    expect(d.jobs.map(j => j.chunks.map(c => [c.start, c.end]))).toEqual([
      [[0x0800, 0x080b], [0x1000, 0x1258]],
      [[0x4000, 0x42bc], [0x6000, 0x612c]],
      [[0x2000, 0x2190]],
      [[0xcf00, 0xd100]],
    ]);
    JOBS.forEach((j, i) => j.chunks.forEach((c, k) => expect([...d.jobs[i].chunks[k].bytes]).toEqual(c.bytes)));
    expect(d.jobs.every(j => j.missing === 0)).toBe(true);
  });

  it('read the labels to seek to, a jump after a job and loading under the I/O area', () => {
    const d = read();
    expect(d.jobs.map(j => j.labels)).toEqual([[], [1], [2, 0x1f], []]);
    expect(d.jobs.map(j => [j.jump, j.shadow])).toEqual([[null, false], [null, false], [null, false], [0x307a, true]]);
    // the first job's chain record is in 18/17; batches of 2 sectors make the jobs span tracks (18 is skipped)
    const small = read(JOBS, { perBatch: 2 });
    expect(small.jobs[0]).toMatchObject({ track: 18, sector: 17 });
    JOBS.forEach((j, i) => j.chunks.forEach((c, k) => expect([...small.jobs[i].chunks[k].bytes]).toEqual(c.bytes)));
  });

  it('follow the tracks past track 18', () => {
    const many: FakeJob[] = Array.from({ length: 40 }, (_, i) => ({ chunks: [{ start: 0x2000 + i * 0x100, bytes: NOISE(500, i) }] }));
    const d = read(many, { perBatch: 8 });
    expect(d.jobs.length).toBe(40);
    expect(d.jobs.some(j => j.track > 18)).toBe(true);
    many.forEach((j, i) => expect([...d.jobs[i].chunks[0].bytes]).toEqual(j.chunks[0].bytes));
  });

  it('read the knock codes of a trackmo on several sides, and the boot program going elsewhere', () => {
    const d = read(JOBS.slice(0, 1), { knock: 0xb0504c, next: 0xb0504d, start: 0xff40, resident: 0x0c });
    expect(d).toMatchObject({ knock: 0xb0504c, next: 0xb0504d, start: 0xff40, resident: 0x0c });
  });

  it('write the load script the way Spin reads it', () => {
    const d = read();
    expect(spinChunkName(d.jobs[1], d.jobs[1].chunks[0])).toBe('job02_4000.bin');
    expect(spinScript(d, 'demo.d64')).toEqual([
      '# Spin load script, rebuilt by Mimir Studio from demo.d64 (Spindle 3): 4 jobs.',
      '# A paragraph is a loader call. The file names are made up: each is the bytes the job loads at that address.',
      '# spin -e 0800',
      '',
      'job01_0800.bin     0800    # $0800-$080a, 11 bytes',
      'job01_1000.bin     1000    # $1000-$1257, 600 bytes',
      '',
      '01:',
      'job02_4000.bin     4000    # $4000-$42bb, 700 bytes',
      'job02_6000.bin     6000    # $6000-$612b, 300 bytes',
      '',
      '02:',
      '1f:',
      'job03_2000.bin     2000    # $2000-$218f, 400 bytes',
      '',
      '# job 4: then jumps to $307a',
      'job04_cf00.bin     cf00    # $cf00-$d0ff, 512 bytes',
    ]);
    expect(spinScript(read(JOBS.slice(0, 1), { next: 0x123456 }), 'a.d64').slice(-2)).toEqual(['', '# then the next disk side']);
  });

  it('find none on an ordinary disk', () => {
    expect(readSpindleDisk(makeD64({ name: 'plain', files: [{ name: 'demo', data: new Uint8Array([1, 8, 0x60]) }] }))).toBeNull();
    expect(readSpindleDisk(new Uint8Array(1000))).toBeNull();
  });
});

describe('the Spindle disk fixture', () => {
  it('is fixtures/d64/spindle-demo.d64, which the e2e tests mount', async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const disk = makeSpindleDisk(JOBS);
    const path = join(__dirname, '../../../fixtures/d64/spindle-demo.d64');
    if (process.env.WRITE_FIXTURES) writeFileSync(path, disk);
    expect(new Uint8Array(readFileSync(path))).toEqual(disk);
    expect(readSpindleDisk(disk)!.jobs.length).toBe(4);
    expect(parseD64(disk)).toMatchObject({ name: 'SPINDLE DEMO', files: [expect.objectContaining({ name: 'DEMO', type: 'PRG', track: 18, sector: 8 })] });
  });
});
