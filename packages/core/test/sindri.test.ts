/* Sindri (packages/sindri) as Mimir uses it: fakePack's decruncher gives the demo back byte for
 * byte, with the stand-ins and with VICE's ROMs when VICE is installed; the layer report and the summary the packed
 * notice shows; VICE's ROMs found next to the x64sc in the settings; an Exomizer self-extracting file named by its
 * fingerprint when Exomizer is installed; and, with VICE's 1541 DOS ROM, a program that loads its next file from the
 * disk it came from. */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conclusive, DEFAULT_PACK, depackers, makeD64, makeDemo, makePrg, packerNames, parsePrg, unpackLog, unpackPrg, unpackSummary, type Roms } from '../src';
import { findC64Roms, findExomizer, runExomizer, viceRomFolders } from '../src/node';
import { fakePack } from './helpers/fake-packer';

const demo = makeDemo().prg;
const packed = fakePack(demo, 0x0810);
const roms = findC64Roms();
const modes: [string, Roms | null][] = roms ? [['stand-ins', null], ['ROMs', roms]] : [['stand-ins', null]];

for (const [mode, r] of modes) {
  describe(`Sindri with the ${mode}`, () => {
    it('unpacks fakePack: the demo, byte for byte, starting at $0810', () => {
      const run = unpackPrg(packed, r);
      expect(run.unpacked).toBe(true);
      expect(run.saved).toMatchObject({ layer: 2, start: 0x0801, end: 0x37ff, entry: 0x0810, basic: false });
      expect(run.saved!.prg).toEqual(demo);
      expect(run.layers.map(l => [l.entry, l.kind])).toEqual([[0x080d, 'mover'], [0x0340, 'decoder'], [0x0810, 'program']]);
      expect(depackers(run).map(l => l.entry)).toEqual([0x080d, 0x0340]);
      expect(conclusive(run)).toBe(true);
      // fakePack is no packer the signatures know: its layers go by their fingerprints
      expect(packerNames(run)).toBeNull();
      expect(unpackSummary(run)).toMatch(/^Sindri peels off 2 layers: an unknown mover at \$080d \(fingerprint [0-9a-f]{8}\), then an unknown decoder at \$0340 \(fingerprint [0-9a-f]{8}\); the program starts at \$0810$/);
      const log = unpackLog(run, 'packed.prg', 0x0801, packed.length - 2).split('\n');
      expect(log.slice(0, 2)).toEqual(['packed.prg: $0801-$390c (12.3 KB), 10 SYS2061', `ROMs: ${r ? r.source : 'stand-ins (no ROM files)'}`]);
      expect(log).toContain('layer 1  $0340  jmp from $0839  decoder');
      expect(log).toContain('         text: "FAKEPACK"');
      expect(log.at(-1)).toBe('saved layer 2: $0801-$37ff (12.0 KB), start with SYS 2064 = $0810');
    });

    it('finds nothing to unpack in the plain demo', () => {
      const run = unpackPrg(demo, r);
      expect(run).toMatchObject({ unpacked: false, saved: null });
      expect(packerNames(run)).toBeNull();
      expect(unpackSummary(run)).toMatch(/^Sindri peels off no layer \(it stopped: /);
      expect(unpackLog(run, 'demo.prg', 0x0801, demo.length - 2).split('\n').at(-1)).toBe('nothing was unpacked');
    });
  });
}

describe('the C64 ROMs for Sindri', () => {
  it('are looked for in VICE\'s C64 folder: beside its bin folder, beside the program, in share/vice', () => {
    expect(viceRomFolders(join('vice', 'bin', 'x64sc.exe'))).toEqual([join('vice', 'C64'), join('vice', 'bin', 'C64'), join('vice', 'share', 'vice', 'C64')]);
    expect(viceRomFolders('  ')).toEqual([]);
  });

  it('come from the VICE in the settings first', () => {
    const vice = mkdtempSync(join(tmpdir(), 'mimir-vice-'));
    mkdirSync(join(vice, 'bin'));
    mkdirSync(join(vice, 'C64'));
    writeFileSync(join(vice, 'C64', 'kernal-901227-03.bin'), new Uint8Array(0x2000));
    writeFileSync(join(vice, 'C64', 'basic-901226-01.bin'), new Uint8Array(0x2000));
    writeFileSync(join(vice, 'C64', 'chargen-901225-01.bin'), new Uint8Array(0x1000));
    const found = findC64Roms(join(vice, 'bin', 'x64sc.exe'));
    expect(found?.source).toBe(join(vice, 'bin', '..', 'C64'));
    expect([found?.kernal.length, found?.basic.length, found?.chargen.length]).toEqual([0x2000, 0x2000, 0x1000]);
  });
});

describe.skipIf(!roms?.drive)('Sindri with the disk in a 1541', () => {
  // 10 SYS2061: LOAD "PART2",8,1 through the KERNAL, then JMP $C000
  const boot = makePrg(0x0801, Uint8Array.from([
    0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00,
    0xa9, 0x05, 0xa2, 0x2f, 0xa0, 0x08, 0x20, 0xbd, 0xff, 0xa9, 0x01, 0xa2, 0x08, 0xa0, 0x01, 0x20, 0xba, 0xff,
    0xa9, 0x00, 0x20, 0xd5, 0xff, 0xb0, 0x03, 0x4c, 0x00, 0xc0, 0xee, 0x20, 0xd0, 0x4c, 0x29, 0x08,
    0x50, 0x41, 0x52, 0x54, 0x32,
  ]));
  // inc $d020 / dec $d021 / jmp $c000, and 600 bytes after it
  const part2 = makePrg(0xc000, Uint8Array.from([0xee, 0x20, 0xd0, 0xce, 0x21, 0xd0, 0x4c, 0x00, 0xc0, ...Array.from({ length: 600 }, (_, i) => (i * 37) & 0xff)]));
  const disk = makeD64({ name: 'mimir test', id: 'mt', files: [{ name: 'boot', data: boot }, { name: 'part2', data: part2 }] });

  it('follows the next file the program loads from the disk, and the report names the drive', () => {
    const run = unpackPrg(boot, roms, disk);
    expect(run.layers.map(l => l.entry)).toEqual([0x080d, 0xc000]);
    expect(run.saved).toMatchObject({ entry: 0xc000, start: 0xc000 });
    expect(run.saved!.prg).toEqual(part2);
    expect(unpackLog(run, 'boot', 0x0801, boot.length - 2).split('\n')[2]).toMatch(/^Drive: 1541 with "MIMIR TEST" MT, \d+ bytes read$/);
  });

  it('stops where the program loads without the disk', () => {
    expect(unpackPrg(boot, roms).stop).toMatchObject({ reason: 'load', detail: 'loads "PART2" from device 8' });
  });
});

const vendored = join(__dirname, '..', '..', '..', 'apps', 'desktop', 'vendor', 'exomizer', 'exomizer.exe');
const EXO = findExomizer([process.env.EXOMIZER || '', process.platform === 'win32' && existsSync(vendored) ? vendored : ''].filter(Boolean));

describe.skipIf(!EXO)('an Exomizer self-extracting file', () => {
  it('is named by its fingerprint and unpacks to the demo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mimir-unpacker-'));
    try {
      const sfx = await runExomizer({ exe: EXO!, dir, files: [{ name: 'demo.prg', prg: demo }], prefs: DEFAULT_PACK });
      expect(sfx.ok).toBe(true);
      const run = unpackPrg(sfx.out!.prg, roms);
      expect(packerNames(run)).toMatch(/^Exomizer/);
      expect(unpackSummary(run)).toMatch(/^Sindri peels off \d layers?: .*Exomizer.* \(a decruncher at \$[0-9a-f]{4}\).*; the program starts at \$0810$/);
      // the demo's bytes are all there, in place
      const out = parsePrg('out', run.saved!.prg), d = parsePrg('demo', demo);
      expect(out.load).toBeLessThanOrEqual(d.load);
      expect(out.bytes.subarray(d.load - out.load, d.load - out.load + d.bytes.length)).toEqual(d.bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
