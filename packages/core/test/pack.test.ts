/* Packing with Exomizer: the ranges, the command line, what Exomizer prints, the desfx check, and the real Exomizer
 * when one is found (EXOMIZER env var, the bundled apps/desktop/vendor/exomizer, C:\C64 or PATH): it packs the demo
 * and desfx must decrunch the same bytes. With VICE too, the packed program runs headless and must exit with the
 * checksum of its data, computed after decrunching. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkDecrunched, DEFAULT_PACK, editRanges, extraProblem, makeDemo, makePrg, mergeRanges, packArgs, packFileName, packImage, packInputs, packOutName,
  packParts, packProblem, parseExomizer, parsePrg, rangeCover, type PackPrefs,
} from '../src';
import { findExomizer, findVice, runExomizer } from '../src/node';
import { fromSource, rng } from './helpers/programs';

const P = (o: Partial<PackPrefs> = {}): PackPrefs => ({ ...DEFAULT_PACK, ...o });
const bytes = (n: number, f = (i: number) => i & 0xff) => Uint8Array.from({ length: n }, (_, i) => f(i));

describe('pack ranges', () => {
  it('merges overlapping and touching ranges, and takes ranges out again', () => {
    expect(mergeRanges([{ start: 0x2000, end: 0x2100 }, { start: 0x0810, end: 0x0900 }, { start: 0x0900, end: 0x0a00 }, { start: 0x2050, end: 0x2200 }, { start: 5, end: 5 }]))
      .toEqual([{ start: 0x0810, end: 0x0a00 }, { start: 0x2000, end: 0x2200 }]);
    const r = editRanges([], 0x0810, 0x1000, true);
    expect(editRanges(r, 0x0900, 0x0a00, false)).toEqual([{ start: 0x0810, end: 0x0900 }, { start: 0x0a00, end: 0x1000 }]);
    expect(editRanges(r, 0x0800, 0x2000, false)).toEqual([]);
    expect(rangeCover([{ start: 0x0810, end: 0x0900 }, { start: 0x0a00, end: 0x1000 }], 0x08f0, 0x0a10)).toBe(0x20);
  });

  it('cuts the ranges to the files, file by file, with offsets after the load address', () => {
    const files = [{ name: 'main.prg', load: 0x0801, bytes: bytes(0x1000) }, { name: 'music.prg', load: 0x1000, bytes: bytes(0x800) }];
    const parts = packParts([{ start: 0x0810, end: 0x0820 }, { start: 0x1700, end: 0x1900 }], files);
    expect(parts.map(p => [p.name, p.start, p.offset, p.bytes.length])).toEqual([
      ['main.prg', 0x0810, 0x0f, 0x10], ['main.prg', 0x1700, 0x0eff, 0x0101], ['music.prg', 0x1700, 0x0700, 0x100],
    ]);
    expect(packInputs(parts)).toEqual(['main.prg,$0810,15,16', 'main.prg,$1700,3839,257', 'music.prg,$1700,1792,256']);
    expect(packInputs(packParts(null, files), 'out\\')).toEqual(['out\\main.prg', 'out\\music.prg']);
    expect(packParts([{ start: 0xc000, end: 0xd000 }], files)).toEqual([]);
    // the later file wins where they overlap, as when Exomizer loads them in order
    const img = packImage([{ start: 0x1000, bytes: Uint8Array.of(1, 2, 3) }, { start: 0x1001, bytes: Uint8Array.of(9) }, { start: 0x1005, bytes: Uint8Array.of(7) }])!;
    expect([img.start, [...img.bytes]]).toEqual([0x1000, [1, 9, 3, 0, 0, 7]]);
  });
});

describe('Exomizer command line', () => {
  it('writes the sub command, the start, the options, -o and the in-files', () => {
    expect(packArgs(P(), ['a.prg'], 'a-exo.prg')).toEqual(['sfx', 'sys', '-o', 'a-exo.prg', 'a.prg']);
    expect(packArgs(P({ start: 'jmp', jmp: 0x0810, effect: 'none', ramExit: 0x35, irqExit: false, compat: true, fast: true, extra: '-p 4 -Di_line_number=1987' }), ['a.prg,$0810,15,100'], 'o.prg'))
      .toEqual(['sfx', '$0810', '-n', '-Di_ram_exit=$35', '-Di_irq_exit=0', '-c', '-C', '-p', '4', '-Di_line_number=1987', '-o', 'o.prg', 'a.prg,$0810,15,100']);
    expect(packArgs(P({ start: 'basic', effect: 'x2', irqExit: true }), ['a.prg'], 'o.prg')).toEqual(['sfx', 'basic', '-x2', '-Di_irq_exit=1', '-o', 'o.prg', 'a.prg']);
    expect(packArgs(P({ mode: 'mem', start: 'jmp', jmp: 0x1000, effect: 'none' }), ['a.prg'], 'o.prg')).toEqual(['mem', '-o', 'o.prg', 'a.prg']);
    expect(packArgs(P({ mode: 'mem', memLoad: 'none', forward: true }), ['a.prg'], 'o.bin')).toEqual(['mem', '-l', 'none', '-f', '-o', 'o.bin', 'a.prg']);
    expect(packArgs(P({ mode: 'mem', memLoad: 0x4000 }), ['a.prg'], 'o.prg')).toEqual(['mem', '-l', '$4000', '-o', 'o.prg', 'a.prg']);
  });

  it('names the files so Exomizer reads one name, and refuses paths and -o in the extra options', () => {
    expect(packFileName('My Game, v2@1.PRG')).toBe('My Game_ v2_1.prg');
    expect(packOutName(P(), 'game.prg')).toBe('game-exo.prg');
    expect(packOutName(P({ mode: 'mem', memLoad: 'none' }), 'game.prg')).toBe('game-exo.bin');
    expect(packOutName(P({ out: 'release' }), 'game.prg')).toBe('release.prg');
    expect(packOutName(P({ out: '..\\x.bin' }), 'game.prg')).toBe('_x.bin');
    expect(extraProblem('-p 4 -Di_ram_during=$34 -x "inc $d020"')).toBeNull();
    expect(extraProblem('-o x.prg')).toMatch(/-o is set by the app/);
    expect(extraProblem('-N C:\\secret')).toMatch(/looks like a path/);
    expect(extraProblem('../a.prg')).toMatch(/looks like a path/);
    expect(extraProblem('-- a.prg')).toMatch(/-- is not allowed/);
    expect(packProblem(P({ ranges: [] }))).toMatch(/Choose the blocks/);
    expect(packProblem(P({ start: 'jmp' }))).toMatch(/Enter the address/);
    expect(packProblem(P({ mode: 'mem', start: 'jmp' }))).toBeNull();
  });
});

describe('Exomizer output', () => {
  const SFX = [
    ' Reading "t.prg", loading from $0801 to $0FE5.', ' Crunching from $0801 to $0FE5.', '', 'Phase 3: Generating output file',
    ' Length of crunched data: 56 bytes.', ' Crunched data reduced 1964 bytes (97.23%)', ' Target is self-decrunching C64 executable,',
    ' jmp address $0810.', ' Writing "a.prg" as prg, saving from $0801 to $095F.', 'Memory layout:   |Start |End   |',
    ' Crunched data   | $07E7| $081E|', ' Decrunched data | $0801| $0FE5|', ' Decrunch table  | $0334| $03D0|',
    ' Decruncher      | $00FD| $01BA| and $A7,$9E,$9F,$AE,$AF,$A8', ' Decrunch effect writes to $DBE7.',
    'Decruncher:  |Enter |During|Exit  |', ' RAM config  |   $37|   $37|   $35|', ' IRQ enabled |     1|     1|     0|',
  ].join('\r\n');

  it('reads the size, the saved range, the memory layout and the decruncher settings', () => {
    const r = parseExomizer(SFX);
    expect(r.crunched).toBe(56);
    expect(r.saved).toEqual({ start: 0x0801, end: 0x095f });
    expect(r.entry).toBe(0x0810);
    expect(r.layout).toEqual([
      { name: 'Crunched data', start: 0x07e7, end: 0x081e }, { name: 'Decrunched data', start: 0x0801, end: 0x0fe5 },
      { name: 'Decrunch table', start: 0x0334, end: 0x03d0 }, { name: 'Decruncher', start: 0x00fd, end: 0x01ba, note: 'and $A7,$9E,$9F,$AE,$AF,$A8' },
    ]);
    expect(r.decruncher).toEqual([{ what: 'RAM config', enter: '$37', during: '$37', exit: '$35' }, { what: 'IRQ enabled', enter: '1', during: '1', exit: '0' }]);
    expect(r.errors).toEqual([]);
    expect(parseExomizer('Error: length 2021 (2021) out of range.').errors).toEqual(['Error: length 2021 (2021) out of range.']);
    expect(parseExomizer(' Writing "a.out" as prg, saving from $0801 to $0FE5, entry1 at $0810.').entry).toBe(0x0810);
  });

  it('compares what desfx decrunched with what was packed', () => {
    const want = { start: 0x0810, bytes: bytes(300) };
    const got = { load: 0x0801, bytes: Uint8Array.from([...bytes(15, () => 0xaa), ...bytes(300), 1, 2]) };
    expect(checkDecrunched(want, got, { want: 0x0810, got: 0x0810 })).toMatchObject({ status: 'same', text: expect.stringMatching(/\$0810–\$093b has the same 300 bytes, and it starts at \$0810/) });
    const bad = { load: got.load, bytes: got.bytes.slice() };
    bad.bytes[15 + 100] ^= 1;
    expect(checkDecrunched(want, bad).status).toBe('differs');
    expect(checkDecrunched(want, bad).text).toMatch(/\$0874/);
    expect(checkDecrunched(want, got, { want: 0x0810, got: 0x0900 })).toMatchObject({ status: 'differs', text: expect.stringMatching(/starts at \$0900 instead of \$0810/) });
    expect(checkDecrunched(want, { load: 0x00fd, bytes: bytes(190) }).status).toBe('unchecked');
    expect(checkDecrunched(want, null).status).toBe('unchecked');
  });
});

const vendored = join(__dirname, '..', '..', '..', 'apps', 'desktop', 'vendor', 'exomizer', 'exomizer.exe');
const EXO = findExomizer([process.env.EXOMIZER || '', process.platform === 'win32' && existsSync(vendored) ? vendored : ''].filter(Boolean));

describe.skipIf(!EXO)('the real Exomizer', () => {
  const inDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), 'kickreasm-pack-'));
    try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
  };
  const demo = makeDemo();
  const f = parsePrg(demo.name, demo.prg);

  it('packs the whole demo as a self-extracting program, and desfx decrunches the same bytes', () => inDir(async dir => {
    const r = await runExomizer({ exe: EXO!, dir, files: [{ name: 'raster demo.prg', prg: demo.prg }], prefs: P() });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.argv.slice(1)).toEqual(['sfx', 'sys', '-o', 'raster demo-exo.prg', 'raster demo.prg']);
    expect(r.out!.prg.length).toBeLessThan(demo.prg.length);
    expect(r.out!.prg[0] | (r.out!.prg[1] << 8)).toBe(0x0801);
    expect(r.packed).toEqual({ start: f.load, length: f.bytes.length });
    expect(r.report.layout.find(a => a.name === 'Decrunched data')).toMatchObject({ start: f.load, end: f.load + f.bytes.length });
    expect(r.check).toMatchObject({ status: 'same' });
    expect(r.check!.argv.slice(1)).toEqual(['desfx', '-o', 'desfx-check.prg', 'raster demo-exo.prg']);
  }));

  it('packs chosen ranges with a jmp, and the decruncher writes exactly them (the gap zero-filled)', () => inDir(async dir => {
    const prg = makePrg(0x1000, bytes(0x3000, i => (i * 7) ^ (i >> 5)));
    const prefs = P({ start: 'jmp', jmp: 0x1000, effect: 'none', ranges: [{ start: 0x1000, end: 0x1800 }, { start: 0x2000, end: 0x3000 }] });
    const r = await runExomizer({ exe: EXO!, dir, files: [{ name: 'game.prg', prg }], prefs });
    expect(r.ok).toBe(true);
    expect(r.argv.slice(1)).toEqual(['sfx', '$1000', '-n', '-o', 'game-exo.prg', 'game.prg,$1000,0,2048', 'game.prg,$2000,4096,4096']);
    expect(r.packed).toEqual({ start: 0x1000, length: 0x2000 });
    expect(r.check).toMatchObject({ status: 'same', text: expect.stringMatching(/starts at \$1000/) });
  }));

  it('writes crunched data for your own decruncher (mem), which it does not check', () => inDir(async dir => {
    const r = await runExomizer({ exe: EXO!, dir, files: [{ name: 'game.prg', prg: demo.prg }], prefs: P({ mode: 'mem', memLoad: 'none' }) });
    expect(r.ok).toBe(true);
    expect(r.out!.name).toBe('game-exo.bin');
    expect(r.out!.prg.length).toBeLessThan(f.bytes.length);
    expect(r.check).toBeNull();
  }));

  it('reports what Exomizer says when it fails', () => inDir(async dir => {
    const r = await runExomizer({ exe: EXO!, dir, files: [{ name: 'game.prg', prg: demo.prg }], prefs: P({ extra: '-t 9999' }) });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.output).toMatch(/target|-t/i);
    const none = await runExomizer({ exe: EXO!, dir, files: [{ name: 'game.prg', prg: demo.prg }], prefs: P({ ranges: [{ start: 0xc000, end: 0xc100 }] }) });
    expect(none).toMatchObject({ ok: false, error: 'None of the chosen blocks is in the built files.' });
  }));
});

const vice = process.env.VICE || findVice();

describe.skipIf(!EXO || !vice)('a packed program in real VICE', () => {
  // headless, with a config of its own (nothing goes to the user's vice.ini); the debug cartridge makes VICE exit with
  // the value the program writes to $d7ff: here the xor of its 4 KB of data, computed after decrunching
  const headless = (dir: string) => ['-config', join(dir, 'vice.ini'), '-default', '-console', '-sounddev', 'dummy', '+confirmonexit', '-debugcart', '-limitcycles', '60000000', '-autostartprgmode', '1'];
  const r = rng(64);
  const data = Array.from({ length: 4096 }, (_, i) => (i % 97 < 40 ? i & 7 : Math.floor(r() * 256)));
  let sum = data.reduce((a, b) => a ^ b, 0);
  if (sum === 0) { data[0] ^= 0x5a; sum = 0x5a; }
  const rows: string[] = [];
  for (let i = 0; i < data.length; i += 32) rows.push(`.byte ${data.slice(i, i + 32).map(v => `$${v.toString(16).padStart(2, '0')}`).join(',')}`);
  // 10 SYS2061: xor the 16 pages from $0900 and exit with it
  const f = fromSource('checksum.prg', ['.pc = $0801', '.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00', '.pc = $080d',
    ' lda #$00', ' sta $fb', ' lda #$09', ' sta $fc', ' ldx #16', ' lda #0', ' ldy #0', 'loop:', ' eor ($fb),y', ' iny', ' bne loop', ' inc $fc', ' dex', ' bne loop',
    ' sta $d7ff', ' jmp *', '.pc = $0900', ...rows].join('\n'));
  const prg = makePrg(f.load, f.bytes);

  const packAndRun = (prefs: PackPrefs) => inTemp(async dir => {
    const res = await runExomizer({ exe: EXO!, dir, files: [{ name: 'checksum.prg', prg }], prefs });
    expect(res.error).toBeUndefined();
    expect(res.check?.status).toBe('same');
    expect(res.out!.prg.length).toBeLessThan(prg.length);
    const out = join(dir, res.out!.name);
    expect(spawnSync(vice!, [...headless(dir), '-autostart', out], { timeout: 90_000, windowsHide: true }).status).toBe(sum);
  });

  it('decrunches and starts through the SYS of its BASIC line', () => packAndRun(P()));

  it('decrunches the chosen blocks and jumps to the start, with $01 = $35 and interrupts off', () =>
    packAndRun(P({ start: 'jmp', jmp: 0x080d, effect: 'x1', ramExit: 0x35, irqExit: false, ranges: [{ start: 0x080d, end: 0x0900 }, { start: 0x0900, end: 0x1900 }] })));
});

async function inTemp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'kickreasm-pack-vice-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
