/* VICE snapshots (.vsf): the real x64sc 3.10 snapshot in fixtures/vsf, and hand-made ones for the other layouts. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze, createProject, deserializeProject, isVsf, makePrg, openC64File, parsePrg, parseVsf, patchSnapshot, render, serializeProject, SNAPSHOT_LOAD, SNAPSHOT_ZP_LOAD, verify } from '../src';

const fixture = (p: string) => new Uint8Array(readFileSync(join(__dirname, '../../../fixtures', p)));
const demo = parsePrg('raster-demo.prg', fixture('prg/raster-demo.prg'));

/** a snapshot as VICE writes it: header, optional version block, then MAINCPU and C64MEM */
function makeVsf(o: { format?: [number, number]; machine?: string; vice?: boolean; pc?: number; port?: [number, number]; ram?: (ram: Uint8Array) => void; mem?: boolean }): Uint8Array {
  const [maj, min] = o.format ?? [2, 0];
  const bytes: number[] = [...'VICE Snapshot File\x1a'].map(c => c.charCodeAt(0)), pad = (s: string, n: number) => [...s.padEnd(n, '\0')].map(c => c.charCodeAt(0));
  bytes.push(maj, min, ...pad(o.machine ?? 'C64SC', 16));
  if (o.vice ?? true) bytes.push(...pad('VICE Version\x1a', 13), 3, 10, 0, 0, 0, 0, 0, 0);
  const module = (name: string, data: number[]) => { const size = 22 + data.length; bytes.push(...pad(name, 16), 1, 0, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, size >>> 24, ...data); };
  const clk = maj >= 2 ? 8 : 4, pc = o.pc ?? 0x0810;
  module('MAINCPU', [...Array(clk).fill(0), 1, 2, 3, 0xf0, pc & 0xff, pc >> 8, 0x20, 0, 0, 0, 0]);
  if (o.mem ?? true) { const ram = new Uint8Array(0x10000); o.ram?.(ram); const [data, dir] = o.port ?? [0x37, 0x2f]; module('C64MEM', [data, dir, 1, 1, ...ram, 0, 0, 0]); }
  return new Uint8Array(bytes);
}

describe('VICE snapshots', () => {
  it('read the RAM, the CPU port and the registers of a real x64sc 3.10 snapshot', () => {
    const b = fixture('vsf/raster-demo.vsf');
    expect(isVsf(b)).toBe(true);
    const s = parseVsf(b);
    expect(s).toMatchObject({ machine: 'C64SC', version: [2, 0], vice: '3.10', port: { data: 0x37, dir: 0x2f } });
    expect(s.cpu).toMatchObject({ pc: 0x08c7, sp: 0xed });
    expect(s.modules.map(m => m.name)).toEqual(expect.arrayContaining(['MAINCPU', 'C64MEM', 'CIA1', 'VIC-II']));
    expect(s.ram.length).toBe(0x10000);
    expect(s.ram.subarray(demo.load, demo.load + demo.bytes.length)).toEqual(demo.bytes);
    // the demo set its raster IRQ
    expect(s.ram[0x0314] | (s.ram[0x0315] << 8)).toBe(0x08b7);
  });

  it('open like a PRG: RAM from $0200, entry points at the PC and the IRQ handler, byte-exact again', () => {
    const f = openC64File('raster-demo.vsf', fixture('vsf/raster-demo.vsf'));
    // the BASIC line at $0801 says SYS 2064: the program start (RUN cannot work with $0200-$03ff loaded)
    expect(f).toMatchObject({ name: 'raster-demo.prg', load: SNAPSHOT_LOAD, entries: [0x08c7, 0x08b7], start: 0x0810, snapshot: 'VICE 3.10 snapshot of a C64SC, PC $08c7, $01 = $37' });
    expect(f.bytes.length).toBe(0x10000 - SNAPSHOT_LOAD);
    const p = { name: 'raster-demo', files: [f], entries: f.entries };
    const A = analyze(p), R = render(A, p);
    expect(A.labels.get(0x0810)?.name).toBe('start');
    expect(A.insLen[0x08b7]).toBeGreaterThan(0);
    expect(verify(A, R).ok).toBe(true);
  });

  it('open from $0002 with the zero page and the stack, where code can run too', () => {
    const f = openC64File('raster-demo.vsf', fixture('vsf/raster-demo.vsf'), { zeroPage: true });
    expect(f).toMatchObject({ load: SNAPSHOT_ZP_LOAD, entries: [0x08c7, 0x08b7], start: 0x0810 });
    expect(f.bytes.length).toBe(0x10000 - SNAPSHOT_ZP_LOAD);
    const p = { name: 'raster-demo', files: [f], entries: f.entries };
    const A = analyze(p);
    expect(verify(A, render(A, p)).ok).toBe(true);
    // a PC in the stack page is traced only when the stack is opened
    const s = makeVsf({ pc: 0x0100, ram: r => r.set([0xee, 0x20, 0xd0, 0x4c, 0x00, 0x01], 0x0100) });
    expect(openC64File('stack.vsf', s).entries).toEqual([]);
    const z = openC64File('stack.vsf', s, { zeroPage: true });
    expect(z.entries).toEqual([0x0100]);
    expect(analyze({ name: 'stack', files: [z], entries: z.entries }).insLen[0x0100]).toBe(3);
  });

  it('read the older layout (4-byte cycle counter, no version block) and follow the KERNAL banked out', () => {
    const s = parseVsf(makeVsf({ format: [1, 1], vice: false, pc: 0x2000, machine: 'C64' }));
    expect(s).toMatchObject({ machine: 'C64', version: [1, 1], vice: null, cpu: { pc: 0x2000, a: 1, x: 2, y: 3, sp: 0xf0 } });
    // $01 = $35: the CPU's own vectors at $fffe/$fffa are RAM and point to the handlers
    const f = openC64File('x.vsf', makeVsf({ pc: 0x1000, port: [0x35, 0x2f], ram: r => { r.set([0x00, 0x30], 0xfffe); r.set([0x00, 0x31], 0xfffa); r.set([0x00, 0x40], 0x0314); } }));
    expect(f.entries).toEqual([0x1000, 0x3000, 0x3100]);
    // no BASIC line at $0801: no program start
    expect(f.start).toBeUndefined();
    // with the KERNAL in, a PC in the KERNAL is not RAM, and $0314 pointing to the ROM handler is no entry either
    expect(openC64File('y.vsf', makeVsf({ pc: 0xea31, ram: r => r.set([0x31, 0xea], 0x0314) })).entries).toEqual([]);
  });

  it('refuse other machines and damaged snapshots, and open a PRG as a PRG', () => {
    expect(() => parseVsf(makeVsf({ machine: 'C128' }), 'c128.vsf')).toThrow('c128.vsf is a snapshot of a C128, not a C64');
    expect(() => parseVsf(makeVsf({ mem: false }), 'cpu.vsf')).toThrow('cpu.vsf: the snapshot has no C64 memory (C64MEM)');
    const whole = makeVsf({});
    expect(() => parseVsf(whole.subarray(0, whole.length - 100), 'cut.vsf')).toThrow('cut.vsf: the snapshot is damaged');
    expect(() => parseVsf(fixture('prg/raster-demo.prg'), 'demo.prg')).toThrow('demo.prg is not a VICE snapshot');
    expect(openC64File('raster-demo.prg', fixture('prg/raster-demo.prg'))).toEqual(demo);
  });
});

describe('restarting a snapshot (Build & Run)', () => {
  const vsf = fixture('vsf/raster-demo.vsf');

  it('keeps the snapshot with the file it opens as, also in the project file', () => {
    const f = openC64File('raster-demo.vsf', vsf);
    expect(f.vsf).toEqual(vsf);
    expect(openC64File('raster-demo.prg', fixture('prg/raster-demo.prg')).vsf).toBeUndefined();
    const p = createProject({ name: 'raster-demo', files: [f] });
    expect(p.files[0].vsf).toEqual(vsf);
    const back = deserializeProject(JSON.parse(JSON.stringify(serializeProject(p))));
    expect(back.files[0].vsf).toEqual(vsf);
    // project files from before snapshots were kept
    expect(deserializeProject(JSON.parse(JSON.stringify(serializeProject(createProject({ name: 'x', files: [demo] }))))).files[0].vsf).toBeUndefined();
  });

  it('puts the built programs in its RAM and leaves everything else as it was', () => {
    const f = openC64File('raster-demo.vsf', vsf);
    // the program as built (byte-identical): the snapshot does not change
    expect(patchSnapshot(vsf, [makePrg(f.load, f.bytes)])).toEqual(vsf);
    // a changed colour table and a program past $ffff (cut there)
    const out = patchSnapshot(vsf, [makePrg(0x0939, new Uint8Array(16).fill(2)), makePrg(0xfffe, Uint8Array.from([1, 2, 3, 4]))]);
    const s = parseVsf(out), before = parseVsf(vsf);
    expect([...s.ram.subarray(0x0939, 0x0949)]).toEqual(new Array(16).fill(2));
    expect([s.ram[0xfffe], s.ram[0xffff]]).toEqual([1, 2]);
    expect(out.length).toBe(vsf.length);
    expect(s.cpu).toEqual(before.cpu);
    expect(s.port).toEqual(before.port);
    // only those 18 bytes differ, all in the RAM of C64MEM
    const mem = before.modules.find(m => m.name === 'C64MEM')!;
    const diff = [...out.keys()].filter(i => out[i] !== vsf[i]);
    expect(diff.every(i => i >= mem.offset + 4 && i < mem.offset + 4 + 0x10000)).toBe(true);
    expect(diff.length).toBeLessThanOrEqual(18);
  });
});
