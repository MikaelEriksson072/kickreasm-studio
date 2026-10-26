/* The external unpacker: arguments, which file it wrote, the start address and packer it reports, a stand-in for
 * unp64 (test/helpers/fake-unp64.cjs, run with this Node), and the real unp64 when it is installed (UNP64 env var,
 * C:\C64 or PATH): it emulates the decruncher of fakePack() and must hand back the demo. */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, detectPacking, makeDemo, parsePrg } from '../src';
import { canIdentify, findUnp64, identifyPacker, pickUnpacked, runUnpacker, unpackArgs, unpackEntry, unpackInputName, unpackPacker } from '../src/node';
import { FAKE_UNP64, fakePack, keyStream } from './helpers/fake-packer';

const inDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'kickreasm-unpack-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

describe('unpacker command', () => {
  it('fills in {in} and {out}, and adds the input when the template has no {in}', () => {
    expect(unpackArgs('{in}', 'a.prg')).toEqual(['a.prg']);
    expect(unpackArgs('', 'a.prg')).toEqual(['a.prg']);
    expect(unpackArgs('-v', 'a.prg')).toEqual(['-v', 'a.prg']);
    expect(unpackArgs('{in} -o {out}', 'my game.prg')).toEqual(['my game.prg', '-o', 'unpacked.prg']);
    expect(unpackArgs('desfx -o {out} {in}', 'my game.prg')).toEqual(['desfx', '-o', 'unpacked.prg', 'my game.prg']);
    expect(unpackArgs('"C:\\tools\\x y.js" {in}', 'a.prg')).toEqual(['C:\\tools\\x y.js', 'a.prg']);
  });

  it('names the packed copy safely', () => {
    expect(unpackInputName('My Game!.PRG')).toBe('My Game_.prg');
    expect(unpackInputName('../x.prg')).toBe('_x.prg');
    expect(unpackInputName('')).toBe('packed.prg');
  });

  it('reads the start address from the file name, then unp64\'s "return to mem", never its "Entry point"', () => {
    expect(unpackEntry('game.prg.0810', '')).toBe(0x0810);
    expect(unpackEntry('game.prg.0810.0801', '')).toBe(0x0801); // the last of several passes
    expect(unpackEntry('game.c000.prg', '')).toBe(0xc000);
    // unp64 with -o: "Entry point" is where the packed file starts
    expect(unpackEntry('out.prg', 'Entry point: $081e\npass1, find unpacker: $0020\npass2, return to mem: $0810\nsaved $0810-$9021 as out.prg')).toBe(0x0810);
    expect(unpackEntry('unpacked.prg', 'done, jmp $080d')).toBe(0x080d);
    expect(unpackEntry('unpacked.prg', 'Entry point: $1000')).toBe(0x1000);
    expect(unpackEntry('unpacked.prg', 'nothing here, $d020')).toBeNull();
  });

  it('reads the packer unp64 names', () => {
    expect(unpackPacker('\nDoynamite/Bitnax v0.4, unpacker=$0020\nEntry point: $081e')).toBe('Doynamite/Bitnax v0.4');
    expect(unpackPacker('a.prg : 1001 CardCruncher Old Packer, unpacker=$00ff')).toBe('1001 CardCruncher Old Packer');
    expect(unpackPacker('demo.prg :  (Unknown)')).toBeNull();
    expect(canIdentify('C:\\C64\\unp64\\unp64.exe')).toBe(true);
    expect(canIdentify('/usr/local/bin/unp64')).toBe(true);
    expect(canIdentify('C:\\tools\\exomizer.exe')).toBe(false);
  });

  it('picks {out}, else the largest new file', () => {
    const before = new Map([['in.prg', 1], ['old.txt', 5]]);
    const f = (name: string, size: number, mtimeMs = 9) => ({ name, size, mtimeMs });
    expect(pickUnpacked([f('in.prg', 100, 1), f('old.txt', 900, 5), f('a.0810', 300), f('unpacked.prg', 200)], before, 'in.prg')).toBe('unpacked.prg');
    expect(pickUnpacked([f('in.prg', 100, 1), f('old.txt', 900, 5), f('a.0810', 300), f('log.txt', 20)], before, 'in.prg')).toBe('a.0810');
    expect(pickUnpacked([f('in.prg', 100, 9), f('old.txt', 900, 5)], before, 'in.prg')).toBeNull();
  });
});

const demo = makeDemo().prg;
const packed = fakePack(demo, 0x0810);

describe('running an unpacker', () => {
  it('the packed demo looks packed: a short trace, then ~8 bits per byte', () => {
    const r = detectPacking(analyze({ name: 'p', files: [parsePrg('p.prg', packed)] }));
    expect(r).toMatchObject({ verdict: 'packed', decruncher: 0x080d });
    expect(r!.entropy).toBeGreaterThan(7.9);
    expect(keyStream(4)).toEqual(Uint8Array.from([0x70, 0x38, 0x9c, 0x4e]));
  });

  it('unpacks with the tool and finds its file, start address and packer', () => inDir(async dir => {
    const r = await runUnpacker({ exe: process.execPath, args: `"${FAKE_UNP64}" {in}`, dir, name: 'Raster Demo.prg', prg: packed });
    expect(r).toMatchObject({ ok: true, code: 0, entry: 0x0810, packer: 'FakePack', file: { name: 'Raster Demo.prg.0810' } });
    expect(r.file!.prg).toEqual(demo);
    expect(r.argv).toEqual([process.execPath, FAKE_UNP64, 'Raster Demo.prg']);
  }));

  it('uses {out} when the template names it (the start then comes from the output)', () => inDir(async dir => {
    const r = await runUnpacker({ exe: process.execPath, args: `"${FAKE_UNP64}" --out {out} {in}`, dir, name: 'x.prg', prg: packed });
    expect(r).toMatchObject({ ok: true, entry: 0x0810, file: { name: 'unpacked.prg' } });
    expect(r.file!.prg).toEqual(demo);
  }));

  it('says what went wrong', () => inDir(async dir => {
    expect(await runUnpacker({ exe: join(dir, 'no-such-unp64.exe'), dir, name: 'x.prg', prg: packed })).toMatchObject({ ok: false, code: null, error: 'the unpacker did not run' });
    expect(await runUnpacker({ exe: process.execPath, args: `"${FAKE_UNP64}" --nothing {in}`, dir, name: 'y.prg', prg: packed })).toMatchObject({ ok: false, code: 0, error: 'the unpacker wrote no file' });
    const notPacked = await runUnpacker({ exe: process.execPath, args: `"${FAKE_UNP64}" {in}`, dir, name: 'z.prg', prg: demo });
    expect(notPacked).toMatchObject({ ok: false, code: 1 });
    expect(notPacked.output).toContain('not packed by fakePack');
  }));
});

const unp64 = findUnp64();

describe.skipIf(!unp64)(`real unp64 (${unp64 ?? 'not found'})`, () => {
  it('runs the decruncher of fakePack and saves the demo, named after its start', () => inDir(async dir => {
    const r = await runUnpacker({ exe: unp64!, dir, name: 'Raster Demo.prg', prg: packed });
    expect(r.output).toContain('return to mem: $0810');
    expect(r).toMatchObject({ ok: true, entry: 0x0810, file: { name: 'Raster Demo.prg.0810' } });
    // unp64 saves the memory the program covers (from $0800): the demo's bytes are all there, in place
    const out = parsePrg('out', r.file!.prg), d = parsePrg('demo', demo);
    expect(out.load).toBeLessThanOrEqual(d.load);
    expect(out.bytes.subarray(d.load - out.load, d.load - out.load + d.bytes.length)).toEqual(d.bytes);
  }));

  it('identifies packers it knows (and not the plain demo)', () => inDir(async dir => {
    const plain = await identifyPacker({ exe: unp64!, dir, name: 'demo.prg', prg: demo });
    expect(plain).toMatchObject({ known: false, packer: null });
    expect(plain.output).toContain('(Unknown)');
    expect(plain.argv).toEqual([unp64, 'demo.prg', '-i']);
  }));
});
