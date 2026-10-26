/* The VICE monitor's memory dump: rows, hex and text columns, the character the C64 shows for a byte, the commands,
 * and real VICE when x64sc is found (VICE env var or the usual folders): headless, with a config file of its own, it
 * loads the demo and logs `m`, `i` and `ii`; the rows and the hex column must be what VICE prints. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadedRanges, makeDemo, monitorChar, monitorLine, monitorRows, monitorText, parseMonitorCommand, petsciiToScreen, parsePrg } from '../src';
import { findVice } from '../src/node';

const mem = new Uint8Array(0x10000);
const demo = parsePrg('raster-demo.prg', makeDemo().prg);
mem.set(demo.bytes, demo.load);
const owner = new Int16Array(0x10000).fill(-1);
owner.fill(0, demo.load, demo.load + demo.bytes.length);

describe('the C64 characters of a byte', () => {
  const c = (b: number, screen = false, lower = false) => monitorChar(b, screen, lower);
  it('reads PETSCII in the upper case set, and in the lower case set', () => {
    expect([0x41, 0x5a, 0x40, 0x30, 0x20, 0x5c, 0x5e, 0x5f, 0xa0, 0xff].map(b => c(b)?.ch)).toEqual(['A', 'Z', '@', '0', ' ', '£', '↑', '←', ' ', 'π']);
    // control codes and graphics characters
    for (const b of [0x00, 0x0d, 0x1f, 0x80, 0x9f, 0x61, 0xc1, 0xa6]) expect(c(b), `$${b.toString(16)}`).toBeNull();
    expect([0x41, 0x61, 0xc1].map(b => c(b, false, true)?.ch)).toEqual(['a', 'A', 'A']);
  });

  it('reads screen codes, $80-$ff as the inverse of $00-$7f', () => {
    expect([0x00, 0x01, 0x1a, 0x1c, 0x20, 0x31].map(b => c(b, true)?.ch)).toEqual(['@', 'A', 'Z', '£', ' ', '1']);
    expect(c(0x81, true)).toEqual({ ch: 'A', inv: true });
    expect(c(0xa0, true)).toEqual({ ch: ' ', inv: true });
    expect(c(0x41, true)).toBeNull();
    expect([0x01, 0x41].map(b => c(b, true, true)?.ch)).toEqual(['a', 'A']);
    expect([0x41, 0x61, 0xc1, 0x0d].map(petsciiToScreen)).toEqual([0x01, 0x41, 0x41, null]);
  });
});

describe('the dump', () => {
  it('has rows from the start of each loaded range', () => {
    const o = new Int16Array(0x10000).fill(-1);
    o.fill(0, 0x0801, 0x0820); o.fill(1, 0xc000, 0xc005);
    const ranges = loadedRanges(o);
    expect(ranges).toEqual([{ start: 0x0801, end: 0x0820 }, { start: 0xc000, end: 0xc005 }]);
    expect(monitorRows(ranges, 16)).toEqual([{ a: 0x0801, n: 16 }, { a: 0x0811, n: 15 }, { a: 0xc000, n: 5 }]);
    // rows started where a command starts them (ii 0985): a shorter row first
    expect(monitorRows([{ start: 0x0801, end: 0x0900 }], 40, 0x0985).slice(0, 2)).toEqual([{ a: 0x0801, n: 28 }, { a: 0x081d, n: 40 }]);
    expect(monitorRows([{ start: 0x0801, end: 0x0a00 }], 40, 0x0985).map(r => r.a)).toContain(0x0985);
    expect(monitorRows([{ start: 0x0801, end: 0x0805 }], 16, 0x0810)).toEqual([{ a: 0x0801, n: 4 }]);
  });

  it('writes m rows as VICE does: groups of four, the text column in place on a short row', () => {
    expect(monitorLine(mem, { a: 0x0801, n: 16 }, 'm')).toBe('>C:0801  0b 08 0a 00  9e 32 30 36  34 00 00 00  00 00 00 20   .....2064...... ');
    expect(monitorLine(mem, { a: 0x08f1, n: 15 }, 'm')).toBe(">C:08f1  8d 27 d0 ee  f0 08 ad 2e  09 4a 4a 4a  29 03 aa      .'.......JJJ)..");
    expect(monitorLine(mem, { a: 0x0801, n: 8 }, 'm', { perRow: 8 })).toBe('>C:0801  0b 08 0a 00  9e 32 30 36   .....206');
    expect(monitorLine(mem, { a: 0x0801, n: 12 }, 'i')).toBe(`>C:0801  .....2064...${' '.repeat(28)}`);
    expect(monitorLine(mem, { a: 0x0801, n: 4 }, 'ii')).toBe(`*C:0801  KHJ@${' '.repeat(36)}`);
    expect(monitorText(mem, [{ start: 0x0801, end: 0x0821 }], 'm').split('\n').map(l => l.slice(0, 7))).toEqual(['>C:0801', '>C:0811']);
  });

  it('reads VICE commands, addresses and labels', () => {
    const labels = (n: string) => ({ start: 0x0810, screen: 0x0400 } as Record<string, number>)[n];
    expect(parseMonitorCommand('m 0801 08ff')).toEqual({ mode: 'm', start: 0x0801, end: 0x0900 });
    expect(parseMonitorCommand('mem $0801')).toEqual({ mode: 'm', start: 0x0801 });
    expect(parseMonitorCommand('ii .screen 07e7', labels)).toEqual({ mode: 'ii', start: 0x0400, end: 0x07e8 });
    expect(parseMonitorCommand('i')).toEqual({ mode: 'i' });
    expect(parseMonitorCommand('start', labels)).toEqual({ start: 0x0810 });
    expect(parseMonitorCommand('c000-c0ff')).toEqual({ start: 0xc000, end: 0xc100 });
    expect(parseMonitorCommand('m 0900 0800')).toMatchObject({ error: expect.stringMatching(/before the start/) });
    expect(parseMonitorCommand('m nowhere')).toMatchObject({ error: expect.stringMatching(/neither a hex address nor a label/) });
    expect(parseMonitorCommand('')).toMatchObject({ error: expect.any(String) });
  });
});

const vice = process.env.VICE || findVice();

describe.skipIf(!vice)(`the dump against real VICE (${vice ?? 'not found'})`, () => {
  it('has the rows and hex column x64sc prints for m, and the rows of i and ii', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kickreasm-monitor-'));
    try {
      const prg = join(dir, 'demo.prg'), log = join(dir, 'mon.log'), cmds = join(dir, 'dump.mon');
      await writeFile(prg, makeDemo().prg);
      await writeFile(cmds, [`logname "${log}"`, 'log on', `l "${prg}" 0`, 'm 0801 08ff', 'i 0801 087f', 'ii 0801 087f', 'log off', 'quit', ''].join('\n'));
      const args = ['-config', join(dir, 'vice.ini'), '-default', '-console', '-sounddev', 'dummy', '+confirmonexit', '-limitcycles', '30000000', '-moncommands', cmds, '-initbreak', 'ready'];
      spawnSync(vice!, args, { timeout: 90_000, windowsHide: true });
      // VICE writes the text column as the bytes themselves (its monitor draws them with the C64 font), a $0a too:
      // the rows are found by their prefix, not by line breaks
      const out = (await readFile(log)).toString('latin1');
      const rows = [...out.matchAll(/([>*])C:([0-9a-f]{4}) {2}/g)].map((m, i, all) => ({ mark: m[1], a: parseInt(m[2], 16), body: out.slice(m.index! + m[0].length, all[i + 1]?.index ?? out.length) }));
      const m = rows.slice(0, 16), i = rows.slice(16, 20), ii = rows.slice(20, 24);
      expect(rows.length).toBe(24);
      const ours = monitorRows([{ start: 0x0801, end: 0x0900 }], 16);
      expect(m.map(r => r.a)).toEqual(ours.map(r => r.a));
      for (const [k, r] of ours.entries()) {
        const line = monitorLine(mem, r, 'm');
        // the hex column is 50 characters, then three spaces
        expect(`>C:${m[k].a.toString(16).padStart(4, '0')}  ${m[k].body.slice(0, 50 + 3)}`, `row $${r.a.toString(16)}`).toBe(line.slice(0, 9 + 50 + 3));
        // the text column holds the row's bytes (VICE leaves out the $00 bytes)
        expect(m[k].body.slice(53).replace(/[\r\n]+$/, ''), `row $${r.a.toString(16)}`).toBe(String.fromCharCode(...mem.subarray(r.a, r.a + r.n)).replace(/\0/g, '').replace(/[\r\n]+$/, ''));
      }
      expect(i.map(r => [r.mark, r.a])).toEqual(monitorRows([{ start: 0x0801, end: 0x0880 }], 40).map(r => ['>', r.a]));
      expect(ii.map(r => [r.mark, r.a])).toEqual(monitorRows([{ start: 0x0801, end: 0x0880 }], 40).map(r => ['*', r.a]));
      expect(loadedRanges(owner)).toEqual([{ start: 0x0801, end: 0x3800 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
