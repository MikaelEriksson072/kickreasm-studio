import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Disk } from '../src/d64.ts';
import { C1541, programLike } from './tools.ts';

describe('D64 images', () => {
  it('take files and give them back', () => {
    const d = Disk.format('BROKKR', 'BK');
    expect(d.free).toBe(664);
    const a = programLike(5000, 1), b = programLike(254, 2), c = programLike(1, 3);
    d.write('FIRST', a);
    d.write('SECOND', b);
    d.write('THIRD', c);
    expect(d.files().map(f => [f.name, f.blocks])).toEqual([['FIRST', 20], ['SECOND', 1], ['THIRD', 1]]);
    expect(d.read(d.find('first')!)).toEqual(a);
    expect(d.read(d.find('SEC*')!)).toEqual(b);
    expect(d.read(d.find('THIRD')!)).toEqual(c);
    expect(d.free).toBe(664 - 22);
  });

  it('replace a file in its directory entry and free its old blocks', () => {
    const d = Disk.format('X');
    d.write('ONE', programLike(10000, 4));
    d.write('TWO', programLike(100, 5));
    const smaller = programLike(600, 6);
    expect(() => d.write('ONE', smaller)).toThrow(/already a file/);
    d.write('ONE', smaller, { replace: true });
    expect(d.files().map(f => f.name)).toEqual(['ONE', 'TWO']);
    expect(d.read(d.find('ONE')!)).toEqual(smaller);
    expect(d.free).toBe(664 - 3 - 1);
  });

  it('grow the directory past 8 files, and say when the disk is full', () => {
    const d = Disk.format('MANY');
    for (let i = 0; i < 20; i++) d.write(`FILE${i}`, programLike(300, i));
    expect(d.files()).toHaveLength(20);
    expect(() => d.write('HUGE', new Uint8Array(254 * 700))).toThrow(/needs 700 blocks/);
  });

  it.skipIf(!C1541)('are disks VICE\'s c1541 reads', () => {
    const d = Disk.format('BROKKR', 'BK');
    const data = programLike(9000, 7);
    d.write('HAMMER', data);
    for (let i = 0; i < 10; i++) d.write(`F${i}`, programLike(500, i));
    const dir = mkdtempSync(join(tmpdir(), 'brokkr-d64-'));
    writeFileSync(join(dir, 'x.d64'), d.bytes);
    const list = execFileSync(C1541!, ['-attach', join(dir, 'x.d64'), '-list'], { encoding: 'utf8' });
    expect(list).toMatch(/"hammer"\s+prg/i);
    expect(list).toMatch(new RegExp(`${d.free} blocks free`, 'i'));
    execFileSync(C1541!, ['-attach', join(dir, 'x.d64'), '-read', 'hammer', join(dir, 'h.prg')], { stdio: 'pipe' });
    const back = new Uint8Array(require('node:fs').readFileSync(join(dir, 'h.prg')));
    expect(back).toEqual(data);
  });
});
