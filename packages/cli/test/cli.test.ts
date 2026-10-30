import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli';

const capture = (cwd: string) => {
  const lines: string[] = [];
  return { lines, io: { out: (s: string) => lines.push(s), err: (s: string) => lines.push(`ERR ${s}`), cwd } };
};

describe('mimir CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-cli-test-'));

  it('writes the demo, analyses, verifies and exports it', async () => {
    let c = capture(dir);
    expect(await main(['demo', '-o', 'demo.prg'], c.io)).toBe(0);

    c = capture(dir);
    expect(await main(['analyse', 'demo.prg'], c.io)).toBe(0);
    expect(c.lines.join('\n')).toMatch(/\$1000-\$[0-9a-f]{4} {2}Music \(SID\)/);

    c = capture(dir);
    expect(await main(['analyse', 'demo.prg', '--deep'], c.io)).toBe(0);
    expect(c.lines.join('\n')).toMatch(/^\[ok {2}\] Deep analysis: \d+ → \d+ problems? in \d rounds?/m);

    c = capture(dir);
    expect(await main(['verify', 'demo.prg', '--set', 'hwInclude=inline'], c.io)).toBe(0);
    expect(c.lines[0]).toMatch(/^OK {3}demo\.asm: 12287\/12287 bytes identical/);

    c = capture(dir);
    expect(await main(['export', 'demo.prg', '-o', 'out', '--name', 'raster'], c.io)).toBe(0);
    const files = readdirSync(join(dir, 'out'), { recursive: true }).map(String).map(f => f.replace(/\\/g, '/')).sort();
    expect(files).toEqual(expect.arrayContaining(['demo.asm', 'build.bat', 'build.sh', 'README.md', 'raster.mimir.json', 'include/c64-hardware.asm', 'music/music_1000.sid', 'gfx/charset_3000.bin', 'original/demo.prg', 'out/demo.prg']));
    expect(readFileSync(join(dir, 'out', 'out', 'demo.prg'))).toEqual(readFileSync(join(dir, 'demo.prg')));

    c = capture(dir);
    expect(await main(['analyse', 'out/raster.mimir.json', '--json'], c.io)).toBe(0);
    expect(JSON.parse(c.lines.join('\n')).entry).toBe(0x0810);
    expect(JSON.parse(c.lines.join('\n')).packing).toEqual([null]);
  });

  it('says when a PRG is packed', async () => {
    const packed = join(__dirname, '../../../fixtures/prg/packed-demo.prg');
    let c = capture(dir);
    expect(await main(['analyse', packed], c.io)).toBe(0);
    expect(c.lines.join('\n')).toMatch(/\[pack\] packed-demo\.prg is packed: \d+% of the file looks compressed .* Unpack it \(mimir unpack packed-demo\.prg\)/);
    c = capture(dir);
    expect(await main(['analyse', packed, '--json'], c.io)).toBe(0);
    expect(JSON.parse(c.lines.join('\n')).packing[0]).toMatchObject({ verdict: 'packed', decruncher: 0x080d, signature: null });
  });

  it('unpacks a packed PRG with the built-in unpacker and prints its layers', async () => {
    const packed = join(__dirname, '../../../fixtures/prg/packed-demo.prg');
    let c = capture(dir);
    expect(await main(['unpack', packed, '-o', 'unpacked.prg', '--no-roms'], c.io)).toBe(0);
    expect(c.lines.join('\n')).toMatch(/^packed-demo\.prg: \$0801-\$390c \(12\.3 KB\), 10 SYS2061\nROMs: stand-ins \(no ROM files\)\nlayer 0  \$080d  start  /);
    expect(c.lines.join('\n')).toContain('layer 2  $0810  jmp from $036f  program');
    expect(c.lines.at(-1)).toBe(`Wrote ${join(dir, 'unpacked.prg')} (12289 bytes, start $0810)`);
    c = capture(dir);
    expect(await main(['analyse', 'unpacked.prg', '--json'], c.io)).toBe(0);
    expect(JSON.parse(c.lines.join('\n'))).toMatchObject({ entry: 0x0810, packing: [null] });
    // the demo itself is not packed: nothing is written
    c = capture(dir);
    expect(await main(['unpack', 'unpacked.prg', '-o', 'again.prg'], c.io)).toBe(1);
    expect(c.lines.join('\n').split('\n').at(-1)).toBe('nothing was unpacked');
    expect(existsSync(join(dir, 'again.prg'))).toBe(false);
  });

  it('unpacks a D64\'s first PRG with the disk in the drive', async () => {
    const disk = join(__dirname, '../../../fixtures/d64/mimir-demo.d64');
    const c = capture(dir);
    expect(await main(['unpack', disk, '--file', 'sprite', '-o', 'sprite.prg'], c.io)).toBe(1);
    expect(c.lines.join('\n')).toMatch(/^mimir-demo\.d64: "SPRITE": \$c000-/);
    c.lines.length = 0;
    expect(await main(['unpack', disk, '--file', 'nothing'], c.io)).toBe(2);
    expect(c.lines).toEqual(['ERR no PRG named "nothing" on mimir-demo.d64']);
  });

  it('rejects unknown settings and commands', async () => {
    let c = capture(dir);
    expect(await main(['verify', 'demo.prg', '--set', 'nope=1'], c.io)).toBe(2);
    c = capture(dir);
    expect(await main(['frobnicate'], c.io)).toBe(2);
  });
});
