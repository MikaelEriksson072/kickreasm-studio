/* Spindle's effect drivers (analyze/spindle.ts, 5.4c). The drivers below are the ones Spindle 3.1's pefchain (MIT
 * licence) printed with -v -v for five small test parts, linked by the scripts quoted above each; the parts' code is
 * ours: rts, `lda #0 / sta $f0` setups, interrupts that count $f0 up, fadeouts that set the carry. */
import { describe, expect, it } from 'vitest';
import { analyze, demoProject, makePrg, parsePrg, render, spindleScript, verify, type FileInput, type ProjectInput, type SpindleDriver } from '../src';
import { fromSource } from './helpers/programs';

const bytes = (s: string) => s.trim().split(/\s+/).map(x => parseInt(x, 16));
const SETUP = 'a9 00 85 f0 60', IRQ = '48 a9 ff 8d 19 d0 e6 f0 2c 00 00 68 40', RTS = '60', FADE = '38 60';
/** template/earlysetup.s, which pefchain puts in front of the first driver */
const EARLY = `2c 11 d0 30 fb 2c 11 d0 10 fb a9 40 8d ff ff a2 ff 8e fa ff 8e fb ff e8 8e 0e dd 8e 04 dd 8e 05 dd a9 81 8d 0d dd
  a9 19 8d 0e dd ae 12 d0 e8 ec 12 d0 d0 fb a0 00 8c 07 dc a9 3e 8d 06 dc c8 8c 1a d0 88 88 8c 02 dc ea ea ea ea ea ea ea
  ea ea a9 11 8d 0f dc 8a e8 e8 cd 12 d0 d0 d2`;
/** pefchain's blank part: its interrupt and setup */
const BLANK = 'c6 00 48 8a 48 98 48 2c 00 00 68 a8 68 aa 68 4e 19 d0 e6 00 40 a9 00 8d 11 d0 8d 20 d0 8d 15 d0 a9 f0 8d 12 d0 60';

/** memory from `{ address: hex }`, as one file from the lowest address to the highest */
function image(parts: Record<number, string>): FileInput {
  const at = Object.keys(parts).map(Number), lo = Math.min(...at);
  const mem: number[] = [];
  for (const a of at) bytes(parts[a]).forEach((b, i) => { mem[a - lo + i] = b; });
  return { name: 'trackmo.prg', load: lo, bytes: Uint8Array.from(mem, b => b ?? 0) };
}
const project = (f: FileInput): ProjectInput => ({ name: 'trackmo', files: [f] });
const pick = (d: SpindleDriver) => ({ part: d.part, front: d.front, condition: d.condition, next: d.next, ends: d.ends });

/**
 * pefchain -@ e0 of
 *   fxa.pef space / fxb.pef f0 = 05 / | f0 = 20 / fxc.pef - / fxm.pef @ / - stay
 * with fxa at $1000 (prepare, setup, irq, fadeout, cleanup), fxb at $1100 (setup, irq, main, fadeout), fxc at $1200
 * (setup) and fxm at $1300 (all six); the blank part went to $0400.
 */
const DEMO = {
  0x0400: BLANK + ' 78 a9 00 8d fe ff a9 04 8d ff ff 20 15 04 4e 19 d0 58 18 90 fd 18 90 fe',
  0x1000: [RTS, SETUP, IRQ, FADE, RTS, EARLY].join(' ') + ` 18 20 00 10 18 90 12 38 20 00 10 a9 4c 85 f4 68 85 f5 68 85 f6 20 f4 00 38
    78 a9 06 8d fe ff a9 10 8d ff ff 20 01 10 4e 19 d0 58 20 00 02 a9 7f 8d 00 dc a9 10 2c 01 dc f0 f4 a9 7f 8d 00 dc a9 10
    2c 01 dc d0 f4 20 13 10 90 fb 20 15 10 4c 15 11`,
  0x1100: [SETUP, IRQ, RTS, FADE].join(' ') + ' 78 a9 05 8d fe ff a9 11 8d ff ff 20 00 11 4e 19 d0 58 20 12 11 a5 f0 c9 05 d0 f7 4c 36 11',
  0x1136: '20 12 11 a5 f0 c9 20 d0 f7 20 12 11 20 13 11 90 f8 4c 01 12',
  0x1200: RTS + ' 78 20 00 12 20 00 13 4c 17 13',
  0x1300: [RTS, SETUP, IRQ, RTS, FADE, RTS].join(' ') + ' 78 a9 06 8d fe ff a9 13 8d ff ff 20 01 13 4e 19 d0 58 e6 e0 20 13 13 a5 e0 d0 f9 20 13 13 20 14 13 90 f8 20 16 13 4c 26 04',
};

describe('Spindle drivers', () => {
  it('read the parts, their conditions and routines from the drivers pefchain built', () => {
    const A = analyze(project(image(DEMO)));
    expect(A.spindle.map(pick)).toEqual([
      { part: 1, front: 0x108c, condition: { kind: 'space' }, next: 0x1115, ends: 'next' },
      { part: 2, front: 0x1115, condition: { kind: 'value', addr: 0xf0, value: 0x05 }, next: 0x1136, ends: 'next' },
      { part: 2, front: 0x1136, condition: { kind: 'value', addr: 0xf0, value: 0x20 }, next: 0x1201, ends: 'next' },
      { part: 3, front: 0x1201, condition: { kind: 'drop' }, next: 0x1317, ends: 'next' },
      { part: 4, front: 0x1317, condition: { kind: 'sync', addr: 0xe0 }, next: 0x0426, ends: 'next' },
      { part: 5, front: 0x0426, condition: { kind: 'stay' }, next: null, ends: 'stop' },
    ]);
    const [p1, p2, more, p3, p4, blank] = A.spindle;
    // the first driver: the early setup, a side door for seeks and the next disk side, then the front door
    expect(p1).toMatchObject({ first: true, ownSetup: false, start: 0x1016, side: 0x107a, prepare: 0x1000, setup: 0x1001, irq: 0x1006, main: null, fadeout: 0x1013, cleanup: 0x1015, loads: true });
    expect(p2).toMatchObject({ setup: 0x1100, irq: 0x1105, main: 0x1112, fadeout: null, extend: false, loads: false });
    expect(more).toMatchObject({ extend: true, irq: null, setup: null, main: 0x1112, fadeout: 0x1113 });
    // its one call is the next part's prepare, which is below the next driver
    expect(p3).toMatchObject({ setup: 0x1200, prepareNext: 0x1300, cleanup: null });
    expect(p4).toMatchObject({ prepare: 0x1300, setup: 0x1301, irq: 0x1306, main: 0x1313, fadeout: 0x1314, cleanup: 0x1316 });
    expect(blank).toMatchObject({ blank: true, irq: 0x0400, setup: 0x0415, music: null, end: 0x043e });
    expect(A.log.some(l => /^Spindle: 6 effect drivers \(Pefchain\), from \$1016/.test(l.msg))).toBe(true);
  });

  it('write them back as the script', () => {
    expect(spindleScript(analyze(project(image(DEMO))).spindle)).toEqual([
      '# Spindle script, rebuilt by Mimir Studio from the 6 Pefchain drivers in memory.',
      '# The parts are numbered in the order they run; their file names are not in the program.',
      'part1.pef     space      # driver $108c: prepare $1000, setup $1001, irq $1006, fadeout $1013, cleanup $1015; loads',
      'part2.pef     f0 = 05    # driver $1115: setup $1100, irq $1105, main $1112',
      '|             f0 = 20    # driver $1136: main $1112, fadeout $1113',
      'part3.pef     -          # driver $1201: setup $1200',
      'part4.pef     @          # driver $1317: prepare $1300, setup $1301, irq $1306, main $1313, fadeout $1314, cleanup $1316; the interlock at $e0 (pefchain -@ e0)',
      "-             stay       # driver $0426; Pefchain's blank part",
      '# the end of the demo',
    ]);
  });

  it('name the drivers and routines after their part, mark them in the source and still build byte-exact', () => {
    const p = project(image(DEMO));
    const A = analyze(p), R = render(A, p);
    expect(verify(A, R).ok).toBe(true);
    const name = (a: number) => A.labels.get(a)?.name;
    expect([0x1016, 0x107a, 0x108c, 0x1000, 0x1006, 0x1115, 0x1136, 0x1113, 0x1300, 0x1317, 0x0426, 0x0400].map(name)).toEqual([
      'spindle_start', 'part1_seek', 'part1_driver', 'part1_prepare', 'part1_irq', 'part2_driver', 'part2_driver2', 'part2_fadeout', 'part4_prepare', 'part4_driver', 'part5_driver', 'part5_irq',
    ]);
    // the drivers and the routines they call are code
    for (const a of [0x1016, 0x107a, 0x1136, 0x1201, 0x1112, 0x1316]) expect(A.insLen[a]).toBeGreaterThan(0);
    const text = R.files['trackmo.asm'] as string;
    expect(text).toContain('// Spindle effect drivers found by Mimir Studio (the ==== lines mark them), as the script they were built from:\n//   # Spindle script, rebuilt');
    expect(text).toContain('//   part2.pef     f0 = 05    # driver $1115: setup $1100, irq $1105, main $1112\n');
    expect(text).toContain('// ==== Spindle part 1: the early setup and the first driver (script line "part1.pef space") ====\nspindle_start:');
    expect(text).toContain('// ==== Spindle part 1: a seek or the next disk side comes in here ====\npart1_seek:');
    expect(text).toContain('// ==== Spindle part 2: a driver that goes on with it (script line "| f0 = 20") ====\npart2_driver2:');
    expect(text).toContain('        jsr part4_prepare\n');
  });

  /** pefchain -@ e0: 1: / fxa.pef space / fxb.pef @ / fxj.pef - / 2: / fxm.pef stay, at $3000-$7000 (fxj: the J tag) */
  const GRAM = {
    0x0800: BLANK + ' ' + EARLY + ` 18 90 0e a9 4c 85 f4 68 85 f5 68 85 f6 20 f4 00 38 78 a9 00 8d fe ff a9 08 8d ff ff 20 15 08 4e 19 d0
      58 20 00 02 20 00 30 4c 16 30`,
    0x3016: `78 a9 06 8d fe ff a9 30 8d ff ff 20 01 30 4e 19 d0 58 20 00 02 a9 7f 8d 00 dc a9 10 2c 01 dc f0 f4 a9 7f 8d 00 dc
      a9 10 2c 01 dc d0 f4 20 13 30 90 fb 20 15 30 4c 15 40`,
    0x4015: '78 a9 05 8d fe ff a9 40 8d ff ff 20 00 40 4e 19 d0 58 e6 e0 20 12 40 a5 e0 d0 f9 20 12 40 20 13 40 90 f8 4c 17 60',
    0x6017: `78 a9 05 8d fe ff a9 60 8d ff ff 20 00 60 4e 19 d0 58 20 00 02 20 12 60 90 fb aa 30 31 09 80 38 2a a2 18 8e 00 dd
      90 02 a0 10 2c 00 dd 10 fb 8c 00 dd a0 05 88 d0 fd 0a d0 e9 a2 08 8e 00 dd a9 60 48 a9 16 48 a9 00 48 a9 f3 48 4c 00 02
      20 16 60 4c 33 09`,
    0x0900: BLANK + ' a9 4c 85 f4 68 85 f5 68 85 f6 20 f4 00 78 a9 00 8d fe ff a9 09 8d ff ff 20 15 09 4e 19 d0 58 20 00 02 20 00 70 4c 17 70',
    0x7017: '78 a9 06 8d fe ff a9 70 8d ff ff 20 01 70 4e 19 d0 58 20 13 70 18 90 fa 20 16 70 18 90 fe',
  };

  it('read labels to seek to, the interlock, the J tag and a last part that stays', () => {
    const D = analyze(project(image(GRAM))).spindle;
    expect(D.map(pick)).toEqual([
      { part: 1, front: 0x0894, condition: { kind: 'drop' }, next: 0x3016, ends: 'next' },
      { part: 2, front: 0x3016, condition: { kind: 'space' }, next: 0x4015, ends: 'next' },
      { part: 3, front: 0x4015, condition: { kind: 'sync', addr: 0xe0 }, next: 0x6017, ends: 'next' },
      { part: 4, front: 0x6017, condition: { kind: 'drop' }, next: 0x0933, ends: 'next' },
      { part: 5, front: 0x0933, condition: { kind: 'drop' }, next: 0x7017, ends: 'next' },
      { part: 6, front: 0x7017, condition: { kind: 'stay' }, next: null, ends: 'stop' },
    ]);
    // the blank filler pefchain put first has no prepare: the next part's is called after the loader
    expect(D[0]).toMatchObject({ first: true, blank: true, prepare: null, prepareNext: 0x3000, loads: true });
    expect(D[3]).toMatchObject({ jump: true, fadeout: 0x6012, cleanup: 0x6016 });
    // a label (2:) comes in through the side door of the blank part pefchain put before fxm
    expect(D[4]).toMatchObject({ blank: true, side: 0x0926, start: 0x0926 });
    expect(D[5]).toMatchObject({ main: 0x7013, cleanup: 0x7016 });
    const text = spindleScript(D);
    expect(text).toContain('# a label to seek to (its number is on the disk) comes in at $0926');
    expect(text).toContain('part4.pef     -          # driver $6017: setup $6000, irq $6005, fadeout $6012, cleanup $6016; the fadeout picks a label to seek to (J); loads');
  });

  /** pefchain -L 1: 1: / fxa.pef space / fxm.pef 1234 = 56 */
  it('read a script that loops: the label it seeks, and back to the first part', () => {
    const D = analyze(project(image({
      0x0800: BLANK + ' ' + EARLY + ` 18 90 0e a9 4c 85 f4 68 85 f5 68 85 f6 20 f4 00 38 78 a9 00 8d fe ff a9 08 8d ff ff 20 15 08 4e 19 d0
        58 20 00 02 20 00 30 4c 16 30`,
      0x3016: `78 a9 06 8d fe ff a9 30 8d ff ff 20 01 30 4e 19 d0 58 20 00 02 20 00 70 a9 7f 8d 00 dc a9 10 2c 01 dc f0 f4 a9 7f
        8d 00 dc a9 10 2c 01 dc d0 f4 20 13 30 90 fb 20 15 30 4c 17 70`,
      0x7017: `78 a9 06 8d fe ff a9 70 8d ff ff 20 01 70 4e 19 d0 58 20 13 70 ad 34 12 c9 56 d0 f6 20 13 70 20 14 70 90 f8 a9 01 09
        80 38 2a a2 18 8e 00 dd 90 02 a0 10 2c 00 dd 10 fb 8c 00 dd a0 05 88 d0 fd 0a d0 e9 a2 08 8e 00 dd 20 00 02 20 16 70 38
        4c 94 08`,
    }))).spindle;
    expect(D.map(pick)).toEqual([
      { part: 1, front: 0x0894, condition: { kind: 'drop' }, next: 0x3016, ends: 'next' },
      { part: 2, front: 0x3016, condition: { kind: 'space' }, next: 0x7017, ends: 'next' },
      { part: 3, front: 0x7017, condition: { kind: 'value', addr: 0x1234, value: 0x56 }, next: 0x0894, ends: 'next' },
    ]);
    expect(D[1]).toMatchObject({ prepareNext: 0x7000, cleanup: 0x3015 });
    expect(D[2]).toMatchObject({ seek: 1, loads: true, cleanup: 0x7016, prepareNext: null });
    const text = spindleScript(D);
    expect(text.slice(2, 4)).toEqual(['01:', "-             -          # driver $0894; Pefchain's blank part; loads"]);
    expect(text).toContain('part3.pef     1234 = 56  # driver $7017: prepare $7000, setup $7001, irq $7006, main $7013, fadeout $7014, cleanup $7016; loads');
    expect(text[text.length - 1]).toBe('# then back to part 1 (pefchain -L 01)');
  });

  /** pefchain -n 123456: fxa.pef - / fxc.pef - (the last part of a disk side) */
  it('read the last part of a disk side, which waits for the next side', () => {
    const D = analyze(project(image({
      0x3016: EARLY + ` 18 20 00 30 18 90 12 38 20 00 30 a9 4c 85 f4 68 85 f5 68 85 f6 20 f4 00 38 78 a9 06 8d fe ff a9 30 8d ff ff
        20 01 30 4e 19 d0 58 20 00 02 20 13 30 90 fb 20 15 30 4c 01 50`,
      0x5001: '78 20 00 50 20 00 02 a9 02 48 a9 56 48 a9 00 48 a9 f3 48 4c 00 02',
    }))).spindle;
    expect(D.map(pick)).toEqual([
      { part: 1, front: 0x308c, condition: { kind: 'drop' }, next: 0x5001, ends: 'next' },
      { part: 2, front: 0x5001, condition: { kind: 'drop' }, next: null, ends: 'flip' },
    ]);
    // no cleanup: the seek jump passes an rts in the resident page
    expect(D[1]).toMatchObject({ setup: 0x5000, loads: true, cleanup: null });
    expect(spindleScript(D).pop()).toBe('# the end of the disk side: then the next side');
  });

  it('tell in a snapshot which part runs, and trace the drivers before it only as guesses', () => {
    const ram = new Uint8Array(0x10000);
    const f = image(DEMO);
    ram.set(f.bytes, f.load);
    ram[0xfffe] = 0x05; ram[0xffff] = 0x11; // fxb's interrupt
    const vsf = makeVsf(0x1127, ram);
    const A = analyze({ name: 's', files: [{ name: 's.prg', load: 0x0200, bytes: ram.slice(0x0200), vsf }], entries: [0x1127] });
    expect(A.spindle.map(d => d.running)).toEqual([false, true, false, false, false, false]);
    expect(spindleScript(A.spindle)[3]).toBe('part2.pef     f0 = 05    # driver $1115: setup $1100, irq $1105, main $1112; running');
  });

  it('do not take older code where the next driver is not loaded yet for a driver', () => {
    // fxc's driver jumps to $1317, where `jsr / jmp` is left from before: fxc's line is the last one
    const D = analyze(project(image({ ...DEMO, 0x0400: '00', 0x1300: RTS, 0x1317: '20 00 13 4c 00 13' }))).spindle;
    expect(D.map(d => d.front)).toEqual([0x108c, 0x1115, 0x1136, 0x1201]);
    expect(spindleScript(D).pop()).toBe('# then the driver at $1317, which is not in memory');
  });

  it('find none in programs without them, also where code installs an interrupt the way a driver does', () => {
    expect(analyze(demoProject()).spindle).toEqual([]);
    const src = '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n sei\n lda #<irq\n sta $fffe\n lda #>irq\n sta $ffff\n jsr setup\n lsr $d019\n cli\nloop: jmp loop\nsetup: rts\nirq: rti\n';
    expect(analyze({ name: 'irq', files: [fromSource('irq.prg', src)] }).spindle).toEqual([]);
  });
});

describe('the Spindle fixture', () => {
  it('is fixtures/prg/spindle-demo.prg, which the e2e tests open', async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const f = image(DEMO), prg = makePrg(f.load, f.bytes);
    const path = join(__dirname, '../../../fixtures/prg/spindle-demo.prg');
    if (process.env.WRITE_FIXTURES) writeFileSync(path, prg);
    expect(new Uint8Array(readFileSync(path))).toEqual(prg);
    expect(analyze({ name: 'spindle-demo', files: [parsePrg('spindle-demo.prg', prg)] }).spindle.length).toBe(6);
  });
});

/** a snapshot as VICE writes it, with the CPU at `pc` and $01 = $35 */
function makeVsf(pc: number, ram: Uint8Array): Uint8Array {
  const out: number[] = [...'VICE Snapshot File\x1a'].map(c => c.charCodeAt(0)), pad = (s: string, n: number) => [...s.padEnd(n, '\0')].map(c => c.charCodeAt(0));
  out.push(2, 0, ...pad('C64SC', 16), ...pad('VICE Version\x1a', 13), 3, 10, 0, 0, 0, 0, 0, 0);
  const module = (name: string, data: number[]) => { const size = 22 + data.length; out.push(...pad(name, 16), 1, 0, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, size >>> 24, ...data); };
  module('MAINCPU', [...Array(8).fill(0), 0, 0, 0, 0xf6, pc & 0xff, pc >> 8, 0x20, 0, 0, 0, 0]);
  module('C64MEM', [0x35, 0x2f, 1, 1, ...ram, 0, 0, 0]);
  return new Uint8Array(out);
}
