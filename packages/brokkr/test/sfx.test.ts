import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSys, ramFor, sfx } from '../src/sfx.ts';
import { EXOMIZER, basicProgram, programLike, rng } from './tools.ts';

// sfx() runs every file it makes in an emulated C64 and compares the memory with the program; these tests make
// files for programs in different places and check what it reports.
const area = (r: ReturnType<typeof sfx>, name: string) => r.areas.find(a => a.name === name)!;

describe('self-extracting files', () => {
  it('start a program at $0801 by its SYS, with the decruncher in the stack page', () => {
    const prog = basicProgram(programLike(20000, 2), 2064);
    const r = sfx(prog, 0x0801);
    expect(r.entry).toBe(2064);
    expect(r.prg[0] | (r.prg[1] << 8)).toBe(0x0801);
    expect(findSys(a => r.prg[a - 0x0801 + 2] ?? 0)).toBe(0x080d);
    expect(area(r, 'Decruncher').start).toBe(0x0100);
    expect(area(r, 'Decrunch table').start).toBe(0x0334);
    expect(r.ramDuring).toBe(0x37);
    expect(r.effect).toBe(true);
    expect(r.prg.length).toBeLessThan(prog.length / 2);
  });

  it('switch I/O out for data under it, and leave $01 and interrupts as told', () => {
    const prog = programLike(0xf000 - 0x1000, 3);
    const r = sfx(prog, 0x1000, { start: 0x1000, ramExit: 0x35, irqExit: false });
    expect(r.ramDuring).toBe(0x34);
    expect(r.effect).toBe(false);
    expect(r.ramExit).toBe(0x35);
    expect(r.irqExit).toBe(false);
    expect(r.warnings.join()).toMatch(/I\/O is switched out/);
  });

  it('find room when the program covers the screen and $0334', () => {
    const r = sfx(programLike(0xc000 - 0x0300, 4), 0x0300, { start: 0x0300 });
    const dec = area(r, 'Decruncher'), table = area(r, 'Decrunch table');
    for (const a of [dec, table]) expect(a.end <= 0x0300 || a.start >= 0xc000).toBe(true);
  });

  it('run a BASIC program with RUN', () => {
    const r = sfx(basicProgram(programLike(3000, 5)), 0x0801, { start: 'basic' });
    expect(r.basic).toBe(true);
    expect(r.ramExit).toBe(0x37);
  });

  it('crunch with a table for length 3 when it is smaller', () => {
    const prog = basicProgram(programLike(12000, 6));
    const auto = sfx(prog, 0x0801, { fourTables: 'auto' });
    const three = sfx(prog, 0x0801);
    expect(auto.prg.length).toBeLessThanOrEqual(three.prg.length);
  });

  it('say what is wrong when they cannot be made', () => {
    expect(() => sfx(programLike(100, 1), 0x0801)).toThrow(/no SYS/);
    expect(() => sfx(programLike(100, 1), 0x2000)).toThrow(/not at \$0801/);
    expect(() => sfx(programLike(0x300, 1), 0x0100, { start: 0x0100 })).toThrow(/top of the stack/);
    const r = rng(9), noise = Uint8Array.from({ length: 0xd000 }, () => Math.floor(r() * 256));
    expect(() => sfx(noise, 0x2000, { start: 0x2000 })).toThrow(/BRK-E1|\$d000/);
  });

  it('know which $01 makes memory RAM', () => {
    expect(ramFor([[0x0801, 0x9fff]])).toBe(0x37);
    expect(ramFor([[0x0801, 0xb000]])).toBe(0x36);
    expect(ramFor([[0xe000, 0xe100]])).toBe(0x35);
    expect(ramFor([[0xc000, 0xd001]])).toBe(0x34);
  });
});

describe.skipIf(!EXOMIZER)('against Exomizer 3.1.1', () => {
  it('Exomizer\'s desfx decrunches a Brokkr file to the same program', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brokkr-sfx-'));
    const prog = basicProgram(programLike(15000, 8), 2064);
    writeFileSync(join(dir, 'b.prg'), sfx(prog, 0x0801).prg);
    const out = execFileSync(EXOMIZER!, ['desfx', '-o', join(dir, 'd.prg'), join(dir, 'b.prg')], { encoding: 'utf8' });
    expect(out).toMatch(/entry1? at \$0810/i);
    const d = new Uint8Array(readFileSync(join(dir, 'd.prg')));
    const load = d[0] | (d[1] << 8), off = 0x0801 - load;
    expect(d.subarray(2 + off, 2 + off + prog.length)).toEqual(prog);
  });
});
