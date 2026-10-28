/* Build & Run's VICE command line (spec 13.2). With a program start set, VICE loads the PRG without RUN and
 * types `sys <start>`; a program over BASIC's work area ($0002-$03ff, a memory dump say) leaves no BASIC to type
 * into, so VICE stops at READY and loads and starts it from the monitor. The real-VICE part runs when x64sc is
 * found (VICE env var or the usual folders): headless (-console), with a config file of its own (nothing is saved
 * to the user's vice.ini), and the debug cartridge makes VICE exit with the value written to $d7ff, which tells
 * which code ran. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeD64, makePrg, overwritesSystemArea, parseVsf, patchSnapshot } from '../src';
import { findVice, prepareVice, viceArgv, viceMonitorScript } from '../src/node';
import { fromSource } from './helpers/programs';
import { readPng } from './helpers/png';

describe('VICE command line', () => {
  it('autostarts without a program start', () => {
    expect(viceArgv({ args: ['-autostartprgmode', '1'], prgPath: 'p.prg', labelsPath: 'p.vs' })).toEqual(['-autostartprgmode', '1', '-moncommands', 'p.vs', '-autostart', 'p.prg']);
  });

  it('loads without RUN and types sys <start> with one', () => {
    expect(viceArgv({ prgPath: 'p.prg', start: 0x0866 })).toEqual(['-autoload', 'p.prg', '-keybuf', 'sys2150\\n']);
    // the virtual file system mode loads through the keyboard buffer itself: inject is used instead
    expect(viceArgv({ args: ['-autostartprgmode', '0'], prgPath: 'p.prg', start: 0x0866 })).toEqual(['-autostartprgmode', '0', '-autostartprgmode', '1', '-autoload', 'p.prg', '-keybuf', 'sys2150\\n']);
    expect(viceArgv({ args: ['-autostartprgmode', '0'], prgPath: 'p.prg' })).toEqual(['-autostartprgmode', '0', '-autostart', 'p.prg']);
  });

  it('starts from the monitor at READY: labels, load at the PRG address, go', () => {
    expect(viceArgv({ args: ['-autostartprgmode', '1'], prgPath: 'p.prg', start: 0x1000, via: 'monitor', scriptPath: 'p.start.mon' }))
      .toEqual(['-autostartprgmode', '1', '-moncommands', 'p.start.mon', '-initbreak', 'ready']);
    expect(viceMonitorScript({ prgPath: 'C:\\b uild\\test.prg', start: 0x1000, labels: 'al C:1000 .start\r\nal C:1010 .loop' }))
      .toBe('al C:1000 .start\nal C:1010 .loop\nl "C:\\b uild\\test.prg" 0\ng 1000\n');
    expect(viceMonitorScript({ prgPath: 'p.prg', start: 0x080d })).toBe('l "p.prg" 0\ng 080d\n');
  });

  it('puts a disk in drive 8, with the inject PRG mode (the disk image mode would replace it)', () => {
    expect(viceArgv({ prgPath: 'p.prg', disk: 'd.d64' })).toEqual(['-autostartprgmode', '1', '-8', 'd.d64', '-autostart', 'p.prg']);
    expect(viceArgv({ args: ['-autostartprgmode', '1'], prgPath: 'p.prg', labelsPath: 'p.vs', start: 0x0801, disk: 'd.d64' }))
      .toEqual(['-autostartprgmode', '1', '-8', 'd.d64', '-moncommands', 'p.vs', '-autoload', 'p.prg', '-keybuf', 'sys2049\\n']);
    expect(viceArgv({ args: ['-autostartprgmode', '2'], prgPath: 'p.prg', disk: 'd.d64' })).toEqual(['-autostartprgmode', '2', '-autostartprgmode', '1', '-8', 'd.d64', '-autostart', 'p.prg']);
    expect(viceArgv({ prgPath: 'p.prg', start: 0x1000, via: 'monitor', scriptPath: 'p.start.mon', disk: 'd.d64' })).toEqual(['-8', 'd.d64', '-moncommands', 'p.start.mon', '-initbreak', 'ready']);
  });

  it('knows which programs overwrite BASIC\'s work area', () => {
    expect(overwritesSystemArea(0x0002, 0xfffe)).toBe(true); // a memory dump
    expect(overwritesSystemArea(0x0326, 2)).toBe(true); // vector-hijacking autostart loaders
    expect(overwritesSystemArea(0x03ff, 1)).toBe(true);
    expect(overwritesSystemArea(0x0400, 0x1000)).toBe(false); // the screen is not BASIC's
    expect(overwritesSystemArea(0x0801, 0x2000)).toBe(false);
    expect(overwritesSystemArea(0x0000, 2)).toBe(false); // $00/$01 are the CPU port, not RAM BASIC needs
  });

  it('picks the start from the PRG and writes the monitor file next to it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mimir-vice-'));
    try {
      const basic = join(dir, 'basic.prg'), dump = join(dir, 'dump.prg'), vs = join(dir, 'dump.vs');
      await writeFile(basic, Uint8Array.from([0x01, 0x08, 0x60]));
      await writeFile(dump, Uint8Array.from([0x02, 0x00, ...new Uint8Array(0x400)]));
      await writeFile(vs, 'al C:0002 .zp\n');
      expect(await prepareVice({ prgPath: basic })).toEqual({ argv: ['-autostart', basic], via: 'run' });
      expect(await prepareVice({ prgPath: dump })).toEqual({ argv: ['-autostart', dump], via: 'run' }); // RUN: the app warns
      expect(await prepareVice({ prgPath: basic, start: 0x0801 })).toEqual({ argv: ['-autoload', basic, '-keybuf', 'sys2049\\n'], via: 'sys' });
      const m = await prepareVice({ prgPath: dump, labelsPath: vs, start: 0x0300 });
      expect(m).toEqual({ argv: ['-moncommands', join(dir, 'dump.start.mon'), '-initbreak', 'ready'], via: 'monitor' });
      expect(await readFile(join(dir, 'dump.start.mon'), 'utf8')).toBe(`al C:0002 .zp\nl "${dump}" 0\ng 0300\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const vice = process.env.VICE || findVice();

describe.skipIf(!vice)(`real VICE (${vice ?? 'not found'})`, () => {
  const headless = (dir: string) => ['-config', join(dir, 'vice.ini'), '-default', '-console', '-sounddev', 'dummy', '+confirmonexit', '-debugcart', '-limitcycles', '40000000', '-autostartprgmode', '1'];
  const prgOf = (f: { load: number; bytes: Uint8Array }) => Uint8Array.from([f.load & 0xff, f.load >> 8, ...f.bytes]);

  it('starts the program at the address it is given, and with RUN otherwise', async () => {
    // 10 SYS2061 → exit $11; the program start set by the user at $0820 → exit $42
    const f = fromSource('start.prg', '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n lda #$11\n sta $d7ff\n jmp *\n.pc = $0820\n lda #$42\n sta $d7ff\n jmp *');
    const dir = await mkdtemp(join(tmpdir(), 'mimir-vice-'));
    try {
      const prgPath = join(dir, 'start.prg');
      await writeFile(prgPath, prgOf(f));
      const run = async (start?: number) => {
        const { argv } = await prepareVice({ args: headless(dir), prgPath, start });
        return spawnSync(vice!, argv, { timeout: 90_000, windowsHide: true }).status;
      };
      expect(await run()).toBe(0x11);
      expect(await run(0x0820)).toBe(0x42);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('puts the disk in drive 8: the program loads its second part from it', async () => {
    // 10 SYS2061: LOAD"PART2",8,1 through the KERNAL, then jump to it; PART2 (on the disk only) exits with $42
    const f = fromSource('loader.prg', '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n lda #5\n ldx #<name\n ldy #>name\n jsr $ffbd\n lda #1\n ldx #8\n ldy #1\n jsr $ffba\n lda #0\n jsr $ffd5\n bcs fail\n jmp $c000\nfail:\n lda #$ee\n sta $d7ff\n jmp *\nname: .byte $50,$41,$52,$54,$32');
    const dir = await mkdtemp(join(tmpdir(), 'mimir-vice-'));
    try {
      const prgPath = join(dir, 'loader.prg'), disk = join(dir, 'disk.d64');
      await writeFile(prgPath, prgOf(f));
      await writeFile(disk, makeD64({ name: 'parts', files: [{ name: 'part2', data: Uint8Array.from([0x00, 0xc0, 0xa9, 0x42, 0x8d, 0xff, 0xd7, 0x4c, 0x05, 0xc0]) }] }));
      const { argv } = await prepareVice({ args: headless(dir), prgPath, disk });
      expect(spawnSync(vice!, argv, { timeout: 90_000, windowsHide: true }).status).toBe(0x42);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('starts a program over BASIC\'s work area (a memory dump from $0002) from the monitor', async () => {
    // zero page, stack and buffers zeroed (the IRQ/BRK/NMI vectors keep their KERNAL values): typing `sys` cannot work
    const f = fromSource('dump.prg', '.pc = $0002\n.byte $00\n.pc = $0314\n.byte $31,$ea,$66,$fe,$47,$fe\n.pc = $0c00\n sei\n lda #$42\n sta $d7ff\n jmp *');
    expect(f.load).toBe(0x0002);
    const dir = await mkdtemp(join(tmpdir(), 'mimir-vice-'));
    try {
      const prgPath = join(dir, 'dump.prg');
      await writeFile(prgPath, prgOf(f));
      const { argv, via } = await prepareVice({ args: headless(dir), prgPath, start: 0x0c00 });
      expect(via).toBe('monitor');
      expect(spawnSync(vice!, argv, { timeout: 90_000, windowsHide: true }).status).toBe(0x42);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restarts a snapshot as it was taken, with the built program in its RAM', async () => {
    // the raster demo's snapshot, taken in its IRQ handler at $08c7: there the program now sets the border and the
    // background to red and stops. VICE goes on from that PC with the patched RAM (the debug cartridge does not
    // survive loading a snapshot, so the screenshot VICE saves when it stops tells)
    const vsf = new Uint8Array(await readFile(join(__dirname, '../../../fixtures/vsf/raster-demo.vsf')));
    const pc = parseVsf(vsf).cpu!.pc;
    const red = Uint8Array.from([0xa9, 0x02, 0x8d, 0x20, 0xd0, 0x8d, 0x21, 0xd0, 0x4c, (pc + 8) & 0xff, (pc + 8) >> 8]);
    const dir = await mkdtemp(join(tmpdir(), 'mimir-vice-'));
    try {
      const shot = async (file: Uint8Array, name: string) => {
        const path = join(dir, `${name}.vsf`), png = join(dir, `${name}.png`);
        await writeFile(path, file);
        // VICE boots, then loads the snapshot; a few frames after that are enough, at full speed
        const args = headless(dir).filter(a => a !== '-debugcart').map(a => (a === '40000000' ? '10000000' : a));
        const { argv, via } = await prepareVice({ args: [...args, '-warp', '-exitscreenshot', png], prgPath: path });
        expect(via).toBe('run');
        spawnSync(vice!, argv, { timeout: 90_000, windowsHide: true });
        return readPng(new Uint8Array(await readFile(png)));
      };
      const isRed = ([r, g, b]: number[]) => r > g + 40 && r > b + 30;
      const patched = await shot(patchSnapshot(vsf, [makePrg(pc, red)]), 'red');
      expect(isRed(patched.pixel(4, 4)), String(patched.pixel(4, 4))).toBe(true);
      expect(isRed(patched.pixel(patched.width >> 1, patched.height - 60))).toBe(true);
      // as it was: the demo's black border
      const before = await shot(vsf, 'demo');
      expect(isRed(before.pixel(4, 4))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
