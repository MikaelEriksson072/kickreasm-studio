/* The Graphics tab's files: Koala Painter and Art Studio pictures with the tab's colours, and .byte source that
 * assembles to the same bytes (with the built-in assembler, and with the real KickAss.jar when it is found). */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artStudioPicture, assemble, gfxSource, koalaPicture, makeShowcase, parsePrg, type GfxFileKind } from '../src';
import { findKickAssJar } from '../src/node';

const colors = { bg: 0, fg: 1, mc1: 15, mc2: 12 };
const bytes = (n: number, f = (i: number) => (i * 37) & 0xff) => Uint8Array.from({ length: n }, (_, i) => f(i));

describe('pictures', () => {
  it('writes a Koala Painter picture: $6000, bitmap, screen nibbles, colour RAM, background', () => {
    const bm = bytes(8000), k = koalaPicture(bm, colors);
    expect(k.length).toBe(10003);
    expect([k[0], k[1]]).toEqual([0x00, 0x60]);
    expect(k.subarray(2, 8002)).toEqual(bm);
    expect(new Set(k.subarray(8002, 9002))).toEqual(new Set([0xfc]));
    expect(new Set(k.subarray(9002, 10002))).toEqual(new Set([0x01]));
    expect(k[10002]).toBe(0);
    // a short selection is padded with zeros
    expect(koalaPicture(bytes(100), colors).subarray(102, 8002).every(b => b === 0)).toBe(true);
  });

  it('writes an Art Studio picture: $2000, bitmap, screen (set bits high), border', () => {
    const a = artStudioPicture(bytes(8000), { ...colors, fg: 7, bg: 6 });
    expect(a.length).toBe(9009);
    expect([a[0], a[1]]).toEqual([0x00, 0x20]);
    expect(new Set(a.subarray(8002, 9002))).toEqual(new Set([0x76]));
    expect(a[9002]).toBe(6);
  });
});

describe('.byte source', () => {
  const build = (src: string, start: number) => {
    const r = assemble({ 'g.asm': `.pc = $${start.toString(16)}\n#import "data.asm"\n`, 'data.asm': src }, 'g.asm');
    expect(r.errors).toEqual([]);
    return parsePrg('g.prg', r.prg!).bytes;
  };

  it('shapes characters, sprites and bitmaps, and assembles to the same bytes', () => {
    const chars = gfxSource('chars', 'charset_2800', 0x2800, bytes(16));
    expect(chars).toContain('// charset_2800: $2800-$280f, 16 bytes (2 characters), saved by Mimir Studio');
    expect(chars).toMatch(/charset_2800:\n {8}\/\/ char 0 at \$2800\n {8}\.byte %00000000\n {8}\.byte %00100101\n/);
    expect(chars).toContain('// char 1 at $2808');
    const sprites = gfxSource('sprites', 'sprite_2000', 0x2000, bytes(128));
    expect(sprites).toContain('// sprite 1 at $2040: pointer $81 in its VIC bank');
    expect(sprites).toMatch(/ {8}\.byte %00000000,%00100101,%01001010\n/);
    expect(sprites.match(/\/\/ padding/g)).toHaveLength(2);
    expect(gfxSource('bitmap', 'bitmap_4000', 0x4000, bytes(640))).toMatch(/\/\/ row 1\n {8}\.byte \$40,/);
    // a screen: a row of 40 screen codes a line; a whole 1 KB has the 24 bytes after it on a line of their own
    const screen = gfxSource('screens', 'screen_0400', 0x0400, bytes(1024, i => i & 0xff));
    expect(screen).toContain('// screen_0400: $0400-$07ff, 1024 bytes (1 screen), saved by Mimir Studio');
    const rows = screen.split('\n').filter(l => l.includes('.byte'));
    expect(rows).toHaveLength(26);
    expect(rows[0].split(',')).toHaveLength(40);
    expect(rows[1]).toMatch(/^ {8}\.byte \$28,\$29,/);
    expect(screen).toMatch(/\/\/ then 16 unused bytes and the 8 sprite pointers\n {8}\.byte \$e8,(\$[0-9a-f]{2},){22}\$ff\n/);
    expect(gfxSource('screens', 's', 0x0400, bytes(1000))).not.toContain('sprite pointers');
    for (const [kind, start, n] of [['chars', 0x2800, 2048], ['sprites', 0x2000, 256], ['sprites', 0x2000, 100], ['bitmap', 0x4000, 8000], ['screens', 0x0400, 1000], ['screens', 0x6000, 2048], ['screens', 0x2345, 1500], ['bytes', 0x1234, 77]] as [GfxFileKind | 'bytes', number, number][]) {
      const b = bytes(n, i => (i * 131 + 7) & 0xff);
      expect(build(gfxSource(kind, 'gfx', start, b), start), `${kind} ${n}`).toEqual(b);
    }
  });

  const jar = process.env.KICKASS_JAR || findKickAssJar();
  const java = !!jar && spawnSync('java', ['-version'], { windowsHide: true }).status === 0;

  it.skipIf(!java)('assembles with the real KickAss.jar to the showcase sprites and charset', async () => {
    const show = parsePrg('s.prg', makeShowcase().prg), at = (a: number, n: number) => show.bytes.subarray(a - show.load, a - show.load + n);
    const dir = await mkdtemp(join(tmpdir(), 'mimir-gfx-'));
    try {
      await writeFile(join(dir, 'sprites.asm'), gfxSource('sprites', 'balls', 0x2000, at(0x2000, 256)));
      await writeFile(join(dir, 'charset.asm'), gfxSource('chars', 'font', 0x2800, at(0x2800, 2048)));
      await writeFile(join(dir, 'main.asm'), '.pc = $2000\n#import "sprites.asm"\n.pc = $2800\n#import "charset.asm"\n');
      const r = spawnSync('java', ['-jar', jar!, 'main.asm', '-o', 'main.prg'], { cwd: dir, windowsHide: true, encoding: 'utf8' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const out = parsePrg('main.prg', new Uint8Array(await readFile(join(dir, 'main.prg'))));
      expect(out.load).toBe(0x2000);
      expect(out.bytes.subarray(0, 256)).toEqual(at(0x2000, 256));
      expect(out.bytes.subarray(0x800, 0x1000)).toEqual(at(0x2800, 2048));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
