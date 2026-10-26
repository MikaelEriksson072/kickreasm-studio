/* .d64 disk images: the directory, free blocks and file chains, against images written here and (when VICE is
 * installed) by VICE's own c1541 tool, which also has to read the images makeD64 writes. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { d64FileName, makeD64, makeDemo, parseD64, parsePrg, petsciiName, readD64File, sectorsOnTrack } from '../src';
import { findVice } from '../src/node';

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 0xff);

describe('d64', () => {
  it('has the 1541 track layout', () => {
    let n = 0;
    for (let t = 1; t <= 35; t++) n += sectorsOnTrack(t);
    expect(n).toBe(683);
    expect([sectorsOnTrack(17), sectorsOnTrack(18), sectorsOnTrack(25), sectorsOnTrack(31), sectorsOnTrack(40)]).toEqual([21, 19, 18, 17, 17]);
  });

  it('reads back what it writes: names, types, sizes, chains, free blocks', () => {
    // 0, 1, 253, 254, 255 and 508 bytes hit every way a last sector can end; 10 files need two directory sectors
    const files = [0, 1, 253, 254, 255, 508, 3000, 7, 8, 9].map((n, i) => ({ name: `file ${i}`, type: i === 1 ? 'SEQ' as const : 'PRG' as const, data: bytes(n, i) }));
    const img = makeD64({ name: 'my disk', id: 'ab', files });
    const d = parseD64(img);
    expect(d).toMatchObject({ name: 'MY DISK', id: 'AB', dosType: '2A', tracks: 35, errorInfo: false });
    expect(d.files.map(f => [f.name, f.type, f.blocks, f.closed])).toEqual(files.map((f, i) => [`FILE ${i}`, f.type, Math.max(1, Math.ceil(f.data.length / 254)), true]));
    for (const [i, f] of d.files.entries()) expect(readD64File(img, f)).toEqual(files[i].data);
    expect(d.freeBlocks).toBe(664 - d.files.reduce((n, f) => n + f.blocks, 0));
  });

  it('opens a PRG from the disk with its load address', () => {
    const demo = makeDemo();
    const img = makeD64({ name: 'demo', files: [{ name: 'raster demo', data: demo.prg }] });
    const [f] = parseD64(img).files;
    const p = parsePrg(d64FileName(f), readD64File(img, f));
    expect(p.name).toBe('RASTER DEMO.prg');
    expect(p.load).toBe(0x0801);
    expect(p.bytes).toEqual(demo.prg.slice(2));
  });

  it('knows the 40- and 42-track sizes and images with error bytes', () => {
    const img = makeD64({ name: 'x', files: [{ name: 'a', data: bytes(600) }] });
    const grow = (n: number) => { const u = new Uint8Array(n); u.set(img); return u; };
    expect(parseD64(grow(175531))).toMatchObject({ tracks: 35, errorInfo: true });
    expect(parseD64(grow(196608))).toMatchObject({ tracks: 40, errorInfo: false });
    expect(parseD64(grow(197376))).toMatchObject({ tracks: 40, errorInfo: true });
    expect(parseD64(grow(205312))).toMatchObject({ tracks: 42, errorInfo: false });
    expect(readD64File(grow(206114), parseD64(img).files[0])).toEqual(bytes(600));
    expect(() => parseD64(new Uint8Array(1000))).toThrow(/not a \.d64 disk image: 1000 bytes/);
  });

  it('lists scratched, splat, locked and DEL entries the way the 1541 does', () => {
    const img = makeD64({ name: 'x', files: [{ name: 'a', data: bytes(10) }, { name: 'b', data: bytes(10) }, { name: 'c', data: bytes(10) }, { name: 'd', data: bytes(10) }] });
    const dir = 357 * 256 + 256; // track 18 sector 1
    img[dir + 0 * 32 + 2] = 0x00; // scratched: not listed
    img[dir + 1 * 32 + 2] = 0x02; // PRG, not closed
    img[dir + 2 * 32 + 2] = 0xc2; // PRG, locked
    img[dir + 3 * 32 + 2] = 0x80; // DEL
    expect(parseD64(img).files.map(f => [f.name, f.type, f.closed, f.locked])).toEqual([['B', 'PRG', false, false], ['C', 'PRG', true, true], ['D', 'DEL', true, false]]);
  });

  it('stops at broken sector chains instead of looping', () => {
    const img = makeD64({ name: 'x', files: [{ name: 'a', data: bytes(600) }] });
    const f = parseD64(img).files[0];
    const off = (f.track - 1) * 21 * 256 + f.sector * 256;
    img[off] = f.track; img[off + 1] = f.sector; // the first sector links to itself
    expect(() => readD64File(img, f)).toThrow(/loops back/);
    img[off] = 99;
    expect(() => readD64File(img, f)).toThrow(/track 99 sector .* is not on the disk/);
  });

  it('turns PETSCII names into text and host file names', () => {
    expect(petsciiName(Uint8Array.from([0x48, 0x49, 0xa0, 0x5c, 0x5e, 0x5f, 0xc1, 0xda, 0x01, 0xa0, 0xa0]))).toBe('HI £↑←az·');
    expect(d64FileName({ name: 'A/B:C*?"<>|.', type: 'PRG' })).toBe('A_B_C______.prg');
    expect(d64FileName({ name: '', type: 'SEQ' })).toBe('file.seq');
    expect(d64FileName({ name: 'x·y', type: 'USR' })).toBe('x_y.usr');
  });
});

const vice = process.env.VICE || findVice();
const c1541 = vice ? join(dirname(vice), process.platform === 'win32' ? 'c1541.exe' : 'c1541') : null;

describe.skipIf(!c1541 || !existsSync(c1541))(`VICE's c1541 (${c1541 ?? 'not found'})`, () => {
  it('reads disks c1541 writes, and c1541 reads disks makeD64 writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kickreasm-d64-'));
    try {
      const demo = makeDemo().prg, small = bytes(300, 5);
      await writeFile(join(dir, 'demo.prg'), demo);
      await writeFile(join(dir, 'small.bin'), small);
      // c1541 writes ASCII names as PETSCII (lower case ASCII is the upper case set)
      const made = spawnSync(c1541!, ['-format', 'test disk,k1', 'd64', join(dir, 'ref.d64'), '-attach', join(dir, 'ref.d64'), '-write', join(dir, 'demo.prg'), 'raster demo', '-write', join(dir, 'small.bin'), 'notes,s'], { windowsHide: true, encoding: 'utf8' });
      expect(made.status, made.stdout + made.stderr).toBe(0);
      const ref = new Uint8Array(await readFile(join(dir, 'ref.d64')));
      const d = parseD64(ref);
      expect(d).toMatchObject({ name: 'TEST DISK', id: 'K1', tracks: 35 });
      expect(d.files.map(f => [f.name, f.type, f.blocks])).toEqual([['RASTER DEMO', 'PRG', 49], ['NOTES', 'SEQ', 2]]);
      expect(readD64File(ref, d.files[0])).toEqual(demo);
      expect(readD64File(ref, d.files[1])).toEqual(small);
      expect(d.freeBlocks).toBe(664 - 51);

      await writeFile(join(dir, 'ours.d64'), makeD64({ name: 'our disk', id: 'zz', files: [{ name: 'raster demo', data: demo }, { name: 'notes', type: 'SEQ', data: small }] }));
      const list = spawnSync(c1541!, ['-attach', join(dir, 'ours.d64'), '-list', '-read', 'raster demo', join(dir, 'back.prg'), '-validate'], { windowsHide: true, encoding: 'utf8' });
      expect(list.status, list.stdout + list.stderr).toBe(0);
      expect(list.stdout).toMatch(/0 "our disk\s*" zz 2a/);
      expect(list.stdout).toMatch(/49\s+"raster demo"\s+prg/);
      expect(list.stdout).toMatch(/2\s+"notes"\s+seq/);
      expect(list.stdout).toMatch(/613 blocks free/);
      expect(new Uint8Array(await readFile(join(dir, 'back.prg')))).toEqual(demo);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
