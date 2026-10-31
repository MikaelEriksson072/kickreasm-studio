/* Brokkr in the Pack view (spec 13.8): the result has the shape of an Exomizer run, the self-extracting file is
 * checked in Brokkr's emulated C64, and the command shown makes the same file with the standalone Brokkr. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerFile } from '@mimir/brokkr/node';
import { brokkrArgs, DEFAULT_PACK, makeDemo, makePrg, packWithBrokkr, parsePrg, type PackPrefs } from '../src';
import { packWithBrokkrThreads } from '../src/node';

const P = (o: Partial<PackPrefs> = {}): PackPrefs => ({ ...DEFAULT_PACK, ...o });
const bytes = (n: number, f = (i: number) => i & 0xff) => Uint8Array.from({ length: n }, (_, i) => f(i));
const demo = makeDemo();
const f = parsePrg(demo.name, demo.prg);
const cli = join(__dirname, '..', '..', 'brokkr', 'src', 'cli.ts');

describe('packing with Brokkr', () => {
  it('packs the whole demo as a self-extracting program, checked in an emulated C64', async () => {
    const r = await packWithBrokkr([{ name: 'raster demo.prg', prg: demo.prg }], P());
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.name).toBe('raster demo-brokkr.prg');
    expect(r.argv).toEqual(['brokkr', 'sfx', '--start', 'sys', '-o', 'raster demo-brokkr.prg', 'raster demo.prg']);
    expect(r.prg!.length).toBeLessThan(demo.prg.length);
    expect(r.prg![0] | (r.prg![1] << 8)).toBe(0x0801);
    expect(r.packed).toEqual({ start: f.load, length: f.bytes.length });
    expect(r.report.layout.find(a => a.name === 'Decrunched data')).toMatchObject({ start: f.load, end: f.load + f.bytes.length });
    expect(r.report.decruncher.find(d => d.what === 'RAM config')?.exit).toBe('$37');
    expect(r.check).toMatchObject({ status: 'same', text: expect.stringMatching(/emulated C64/) });
  });

  it('packs chosen ranges with a jmp, the gap zero-filled, without the effect', async () => {
    const prg = makePrg(0x1000, bytes(0x3000, i => (i * 7) ^ (i >> 5)));
    const prefs = P({ start: 'jmp', jmp: 0x1000, effect: 'none', ranges: [{ start: 0x1000, end: 0x1800 }, { start: 0x2000, end: 0x3000 }] });
    const r = await packWithBrokkr([{ name: 'game.prg', prg }], prefs);
    expect(r.ok).toBe(true);
    expect(r.argv).toEqual(['brokkr', 'sfx', '--start', '$1000', '--no-effect', '-o', 'game-brokkr.prg', 'game.prg,$1000,0,2048', 'game.prg,$2000,4096,4096']);
    expect(r.packed).toEqual({ start: 0x1000, length: 0x2000 });
    expect(r.check).toMatchObject({ status: 'same', text: expect.stringMatching(/starts at \$1000/) });
  });

  it('writes crunched data (mem) whose stream it decrunches again', async () => {
    const r = await packWithBrokkr([{ name: 'game.prg', prg: demo.prg }], P({ mode: 'mem', memLoad: 'none' }));
    expect(r.ok).toBe(true);
    expect(r.name).toBe('game-brokkr.bin');
    expect(r.prg!.length).toBeLessThan(f.bytes.length);
    expect(r.check?.text).toMatch(/decrunched the stream again/);
    expect(brokkrArgs(P({ mode: 'mem', memLoad: 0x2000, forward: true, compat: true, effort: 'fast' }), ['a.prg'], 'a-brokkr.prg'))
      .toEqual(['brokkr', 'mem', '-f', '-l', '$2000', '-T', '5', '--effort', 'fast', '-o', 'a-brokkr.prg', 'a.prg']);
  });

  it('says what is wrong instead of packing', async () => {
    const noSys = await packWithBrokkr([{ name: 'game.prg', prg: makePrg(0x1000, bytes(4000)) }], P());
    expect(noSys).toMatchObject({ ok: false, error: expect.stringMatching(/not at \$0801/) });
    expect(noSys.output).toMatch(/BRK-E110/);
    const none = await packWithBrokkr([{ name: 'game.prg', prg: demo.prg }], P({ ranges: [{ start: 0xc000, end: 0xc100 }] }));
    expect(none).toMatchObject({ ok: false, error: 'None of the chosen blocks is in the built files.' });
  });

  it('makes the same file as the command it shows, run with the standalone Brokkr in the pack folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mimir-brokkr-'));
    try {
      const prg = makePrg(0x1000, bytes(0x3000, i => (i * 13) ^ (i >> 3)));
      const r = await packWithBrokkr([{ name: 'game.prg', prg }], P({ start: 'jmp', jmp: 0x1000, ranges: [{ start: 0x1000, end: 0x1800 }, { start: 0x2400, end: 0x3000 }] }));
      for (const i of r.inputs) await writeFile(join(dir, i.name), i.prg);
      const run = spawnSync(process.execPath, [cli, ...r.argv.slice(1), '-q'], { cwd: dir, encoding: 'utf8' });
      expect(run.stderr).toBe('');
      expect(new Uint8Array(await readFile(join(dir, r.name!)))).toEqual(r.prg);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("packs in Brokkr's own format, smaller, as the command it shows does", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mimir-brokkr-'));
    try {
      // text in a random order: adaptive coding takes its letters in fewer bits than Exomizer's literals
      let seed = 7;
      const text = 'BROKKR AND SINDRI FORGED THE HAMMER. ';
      const prg = makePrg(0x1000, bytes(0x3000, () => text.charCodeAt((seed = (seed * 1103515245 + 12345) >>> 0) % text.length)));
      const prefs = P({ format: 'brokkr', start: 'jmp', jmp: 0x1000, compat: true });
      const r = await packWithBrokkr([{ name: 'game.prg', prg }], prefs);
      const exo = await packWithBrokkr([{ name: 'game.prg', prg }], { ...prefs, format: 'exomizer' });
      expect(r.ok).toBe(true);
      expect(r.argv).toEqual(['brokkr', 'sfx', '--format', 'brokkr', '--start', '$1000', '-o', 'game-brokkr.prg', 'game.prg']);
      expect(r.report.layout.map(a => a.name)).toContain('Probabilities');
      expect(r.check?.status).toBe('same');
      expect(r.prg!.length).toBeLessThan(exo.prg!.length);
      for (const i of r.inputs) await writeFile(join(dir, i.name), i.prg);
      const run = spawnSync(process.execPath, [cli, ...r.argv.slice(1), '-q'], { cwd: dir, encoding: 'utf8' });
      expect(run.stderr).toBe('');
      expect(new Uint8Array(await readFile(join(dir, r.name!)))).toEqual(r.prg);
      const mem = await packWithBrokkr([{ name: 'game.prg', prg }], P({ format: 'brokkr', mode: 'mem' }));
      expect(mem.ok).toBe(true);
      expect(mem.check?.text).toMatch(/decruncher --format brokkr/);
      expect(await packWithBrokkr([{ name: 'game.prg', prg }], P({ format: 'brokkr', mode: 'mem', forward: true })))
        .toMatchObject({ ok: false, error: expect.stringMatching(/decrunched backward/) });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('spreads effort max over threads', async () => {
    const prg = makePrg(0x1000, bytes(3000, i => (i * 5) ^ (i >> 4)));
    const prefs = P({ effort: 'max', start: 'jmp', jmp: 0x1000 });
    const r = await packWithBrokkrThreads([{ name: 'small.prg', prg }], prefs, workerFile, 2);
    const normal = await packWithBrokkr([{ name: 'small.prg', prg }], { ...prefs, effort: 'normal' });
    expect(r.ok).toBe(true);
    expect(r.check?.status).toBe('same');
    expect(r.prg!.length).toBeLessThanOrEqual(normal.prg!.length);
  });
});
