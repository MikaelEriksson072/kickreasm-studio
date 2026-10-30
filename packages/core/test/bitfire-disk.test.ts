/* Bitfire disks (c64/bitfire-disk.ts, spec 13.5c). The disks are built the way d64write writes them, and the packed
 * files the way dali writes them (test/helpers/bitfire-disk.ts). The reader was also checked against released Bitfire
 * disks: every file of the 1.x ones unpacks, and the files of the 0.x ones follow each other. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { d64writeScript, makeD64, parseD64, readBitfireDisk, sectorsOnTrack, unpackDali } from '../src';
import { Dali, makeBitfireDisk, packDali, type FakeBitfireFile } from './helpers/bitfire-disk';

/** the bytes of literals and copies (an offset of 0: the last one again), as a plain decoder makes them */
function expand(steps: ([number[]] | [number, number])[]): number[] {
  const out: number[] = [];
  let last = 1;
  for (const s of steps) {
    if (s.length === 1) out.push(...s[0]);
    else { const [len, off] = s; if (off) last = off; for (let i = 0; i < len; i++) out.push(out[out.length - last]); }
  }
  return out;
}

/** a file packed with an end, unpacking to $1000: literal, match, literal, repeat, a match of 300 (a 16-bit length) ... */
function packedWithEnd(): { packed: number[]; plain: number[] } {
  const w = new Dali();
  w.literal([0x61, 0x62], true); w.match(5, 2); w.literal([0x63]); w.rep(4); w.match(300, 3); w.literal([1, 2, 3]); w.match(2, 7); w.end();
  return { packed: [0x00, 0x10, ...w.out], plain: expand([[[0x61, 0x62]], [5, 2], [[0x63]], [4, 0], [300, 3], [[1, 2, 3]], [2, 7]]) };
}
/** a file packed in place: 4 bytes, a match of 200, and the last 96 bytes as they are, ending at $3000 */
function packedInPlace(): { packed: number[]; plain: number[]; load: number } {
  const tail = Array.from({ length: 96 }, (_, i) => (i * 7) & 0xff);
  const w = new Dali();
  w.literal([1, 2, 3, 4], true); w.match(200, 4);
  const plain = [...expand([[[1, 2, 3, 4]], [200, 4]]), ...tail];
  const start = 0x3000 - plain.length, packed = [start & 0xff, start >> 8, ...w.out, ...tail];
  return { packed, plain, load: 0x3000 - packed.length };
}

describe('dali, Bitfire 1.x packer', () => {
  it('unpacks a file with an end: literals, matches, a repeated offset and a 16-bit length', () => {
    const { packed, plain } = packedWithEnd();
    const u = unpackDali(Uint8Array.from(packed), 0x8000);
    expect(u).toMatchObject({ start: 0x1000, end: 0x1000 + plain.length, inplace: false });
    expect([...u!.bytes]).toEqual(plain);
    // a byte more after the end is not this file
    expect(unpackDali(Uint8Array.from([...packed, 0]), 0x8000)).toBeNull();
  });

  it('unpacks a file packed in place: it ends where writing reaches reading', () => {
    const { packed, plain, load } = packedInPlace();
    const u = unpackDali(Uint8Array.from(packed), load);
    expect(u).toMatchObject({ start: 0x3000 - plain.length, end: 0x3000, inplace: true });
    expect([...u!.bytes]).toEqual(plain);
  });

  it('is no packed file for other bytes', () => {
    expect(unpackDali(new TextEncoder().encode('MIMIR STUDIO READS BITFIRE DISKS'), 0x2000)).toBeNull();
    expect(unpackDali(Uint8Array.from([0x00, 0x10]), 0x2000)).toBeNull();
  });
});

const offset = (t: number, s: number) => { let n = 0; for (let k = 1; k < t; k++) n += sectorsOnTrack(k); return (n + s) * 256; };

describe('a Bitfire disk', () => {
  const inplace = packedInPlace(), withEnd = packedWithEnd();
  const raw = Array.from({ length: 600 }, (_, i) => (i * 13 + 5) & 0xff);
  const files: FakeBitfireFile[] = [{ load: inplace.load, bytes: inplace.packed }, { load: 0x4000, bytes: raw }, { load: 0x9000, bytes: withEnd.packed }];

  it.each(['1.2', '1.1+', '1.0'] as const)('reads the files of format %s, from track 1 with no gap, and unpacks the packed ones', format => {
    const d = readBitfireDisk(makeBitfireDisk(format, files, { name: 'MIMIR SIDE 2', side: 2 }))!;
    expect(d).toMatchObject({ format, side: 2, header: 'MIMIR SIDE 2', id: 'BF', boot: 'BOOT', standard: ['NOTE'] });
    expect(d.files.map(f => [f.n, f.load, f.end, f.track, f.sector, f.offset])).toEqual([
      [0, inplace.load, 0x3000, 1, 0, 0],
      [1, 0x4000, 0x4000 + 600, 1, 0, inplace.packed.length],
      [2, 0x9000, 0x9000 + withEnd.packed.length, 1, 8, (inplace.packed.length + 600) & 0xff],
    ]);
    expect([...d.files[0].unpacked!.bytes]).toEqual(inplace.plain);
    expect([...d.files[1].bytes]).toEqual(raw);
    expect(d.files[1].unpacked).toBeNull();
    expect([...d.files[2].unpacked!.bytes]).toEqual(withEnd.plain);
  });

  it('reads the files of format 0.x, each from a sector of its own (bitnax is not unpacked)', () => {
    const d = readBitfireDisk(makeBitfireDisk('0.x', files))!;
    expect(d.format).toBe('0.x');
    expect(d.files.map(f => [f.load, f.track, f.sector])).toEqual([[inplace.load, 1, 0], [0x4000, 1, 4], [0x9000, 1, 16]]);
    expect([...d.files[1].bytes]).toEqual(raw);
    expect(d.files.every(f => !f.unpacked)).toBe(true);
  });

  it('follows the sectors past track 17, every 3rd from 1.2 on, and checks where the second directory sector says its first file starts', () => {
    // a packed file, then 69 of 1700 bytes: they reach past track 18, and file 63 is the first of 18/17
    const fill = (n: number) => Array.from({ length: 1700 }, (_, i) => (n * 31 + i) & 0xff);
    const many = [files[0], ...Array.from({ length: 69 }, (_, n) => ({ load: 0x1000, bytes: fill(n + 1) }))];
    for (const format of ['1.2', '1.0'] as const) {
      const img = makeBitfireDisk(format, many);
      // where file 63 starts: the track, the n-th sector d64write filled on it, that sector, and the byte in it
      const pos = inplace.packed.length + 62 * 1700, il = format === '1.2' ? 3 : 4;
      let track = 1, index = pos >> 8;
      while (index >= sectorsOnTrack(track)) { index -= sectorsOnTrack(track); track += track === 17 ? 2 : 1; }
      const order: number[] = [];
      for (let r = 0; r < (track >= 18 ? il : 4); r++) for (let s = r; s < sectorsOnTrack(track); s += track >= 18 ? il : 4) order.push(s);
      expect(track).toBeGreaterThan(18);
      img.set([track, index, pos & 0xff], offset(18, 17) + (format === '1.0' ? 0xfc : 0));
      const d = readBitfireDisk(img)!;
      expect(d.files).toHaveLength(70);
      expect(d.files[63]).toMatchObject({ track, sector: order[index], offset: pos & 0xff });
      expect(d.files.slice(1).every((f, n) => f.bytes.every((b, i) => b === ((n + 1) * 31 + i & 0xff)))).toBe(true);
      // another start than where the files are: not this format
      img[offset(18, 17) + (format === '1.0' ? 0xfd : 1)] = index + 1;
      expect(readBitfireDisk(img)).toBeNull();
    }
  });

  it('writes the d64write command line, with each file in a comment', () => {
    const s = d64writeScript(readBitfireDisk(makeBitfireDisk('1.2', files, { name: 'MIMIR SIDE 2', side: 2 }))!, 'side2.d64');
    const at = (0x3000 - inplace.plain.length).toString(16);
    expect(s[0]).toBe('# d64write command line, rebuilt by Mimir Studio from side2.d64 (Bitfire 1.2 or later): 3 files on side 2.');
    expect(s).toContain(`#   file00_${at}.lz   loads at $${inplace.load.toString(16)}-$2fff (${inplace.packed.length} bytes), unpacks to $${at}-$2fff (${inplace.plain.length} bytes)`);
    expect(s).toContain('#   file01_4000.lz   loads at $4000-$4257 (600 bytes), not packed');
    expect(s.slice(s.indexOf(''))).toEqual(['', 'd64write -c side2.d64 -h "mimir side 2" -i bf --side 2 \\', '  --boot boot.prg \\',
      `  -b file00_${at}.lz \\`, '  -b file01_4000.lz \\', '  -b file02_1000.lz \\', '  -s note.prg']);
  });

  it('names the boot program and the dirart when the directory is one, all of its lines leading to the boot program', () => {
    const d = readBitfireDisk(makeBitfireDisk('1.2', files, { dirart: ['  ***  ', ' MIMIR ', '  ***  '] }))!;
    expect(d).toMatchObject({ boot: '  ***  ', dirart: 3, standard: ['NOTE'] });
    const s = d64writeScript(d, 'art.d64');
    expect(s).toContain('# The directory is a dirart of 3 lines (dirart.prg and boot.prg are made-up names).');
    expect(s.slice(s.indexOf('') + 1, s.indexOf('') + 4)).toEqual(['d64write -c art.d64 -h "bitfire demo" -i bf --side 1 \\', '  --boot boot.prg \\', '  -a dirart.prg 3 \\']);
  });

  it('is not one: an ordinary disk, or a directory that does not hold together', () => {
    expect(readBitfireDisk(makeD64({ name: 'PLAIN', files: [{ name: 'A', data: Uint8Array.from([1, 8, 0]) }] }))).toBeNull();
    // a directory whose first file does not start at track 1, sector 0, byte 0
    const moved = makeBitfireDisk('1.2', files);
    moved[offset(18, 18) + 2] = 1;
    expect(readBitfireDisk(moved)).toBeNull();
    // 1.2 and after pack with dali: a directory at the front none of whose files unpacks is no Bitfire disk
    expect(readBitfireDisk(makeBitfireDisk('1.2', [{ load: 0x4000, bytes: raw }]))).toBeNull();
    // 0.x: a file that does not start after the one before
    const broken = makeBitfireDisk('0.x', files);
    broken[offset(18, 18) + 7] = 9;
    expect(readBitfireDisk(broken)).toBeNull();
    expect(readBitfireDisk(new Uint8Array(1000))).toBeNull();
  });
});

describe('the Bitfire disk fixture', () => {
  it('is fixtures/d64/bitfire-demo.d64, which the e2e tests mount: the raster demo packed, a table, and a file packed in place', () => {
    const demo = [...readFileSync(join(__dirname, '../../../fixtures/prg/raster-demo.prg'))];
    const packed = packDali(demo.slice(2), demo[0] | (demo[1] << 8));
    const table = Array.from({ length: 256 }, (_, i) => Math.round(127.5 + 127.5 * Math.sin((i / 256) * 2 * Math.PI)));
    const inplace = packedInPlace();
    const disk = makeBitfireDisk('1.2', [{ load: 0x8000, bytes: packed }, { load: 0x4000, bytes: table }, { load: inplace.load, bytes: inplace.packed }]);
    const path = join(__dirname, '../../../fixtures/d64/bitfire-demo.d64');
    if (process.env.WRITE_FIXTURES) writeFileSync(path, disk);
    expect(new Uint8Array(readFileSync(path))).toEqual(disk);
    const d = readBitfireDisk(disk)!;
    expect(d.files.map(f => f.unpacked && [f.unpacked.start, f.unpacked.end])).toEqual([[0x0801, 0x0801 + demo.length - 2], null, [0x3000 - inplace.plain.length, 0x3000]]);
    expect([...d.files[0].unpacked!.bytes]).toEqual(demo.slice(2));
    expect(parseD64(disk)).toMatchObject({ name: 'BITFIRE DEMO', files: [expect.objectContaining({ name: 'BOOT', track: 18 }), expect.objectContaining({ name: 'NOTE', type: 'SEQ' })] });
  });
});
