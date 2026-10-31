import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crunchData } from '../src/crunch.ts';
import { encodingText, parseEncoding, readStream, T } from '../src/format.ts';
import { raw } from '../src/files.ts';
import { EXOMIZER, programLike } from './tools.ts';

const data = programLike(6000, 7);

describe('the Exomizer 3 stream', () => {
  for (const flags of [39, 55, 7, 0, 1, 3, 13, 23, 47, 63]) {
    it(`decrunches to the data with -P${flags}`, () => {
      const c = crunchData(data, { protocol: { flags } });
      expect(readStream(c.stream, flags).data).toEqual(data);
    });
  }

  it('keeps the traits it is told to leave out', () => {
    const c = crunchData(data, { protocol: { traits: T.NO_LIT_SEQ | T.NO_LEN1 | T.NO_MIRRORS } });
    expect(c.stats.sequences).toBe(0);
    expect(c.stats.traits).toBe(0);
    const runs = new Uint8Array(3000).fill(7);
    expect(crunchData(runs, { protocol: { traits: T.NO_MIRRORS, maxLen: 1000 } }).stats.traits & T.NO_MIRRORS).toBe(0);
  });

  it('takes offsets again when it pays, and the decoder counts them', () => {
    const c = crunchData(data);
    expect(c.stats.reused).toBeGreaterThan(0);
    expect(readStream(c.stream, 39).tokens.reused).toBe(c.stats.reused);
  });

  it('writes the stream without its encoding (-E) and reads it with the encoding given', () => {
    const c = crunchData(data, { header: false });
    expect(readStream(c.stream, 39, c.encoding).data).toEqual(data);
    expect(crunchData(data).stream.length - c.stream.length).toBe(26);
  });

  it('reads and writes encodings as Exomizer prints them', () => {
    const e = parseEncoding('012223530A98B660,1123,0000010213102446,0101003444548498', 39);
    expect(encodingText(e)).toBe('012223530A98B660,1123,0000010213102446,0101003444548498');
    expect(() => parseEncoding('0123,1', 39)).toThrow(/tables/);
  });

  it('crunches with a fixed encoding in one round', () => {
    const c = crunchData(data);
    const fixed = crunchData(data, { encoding: c.encoding });
    expect(fixed.rounds).toBe(1);
    expect(encodingText(fixed.encoding)).toBe(encodingText(c.encoding));
  });

  it('finds the in-place margin a decruncher needs', () => {
    const c = crunchData(data.slice().reverse());
    const d = readStream(c.stream, 39);
    expect(d.safety).toBe(c.safety);
    expect(c.safety).toBeGreaterThanOrEqual(0);
  });
});

describe.skipIf(!EXOMIZER)('against Exomizer 3.1.1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brokkr-'));
  const exo = (...args: string[]) => execFileSync(EXOMIZER!, args, { stdio: 'pipe' });

  for (const [name, flags, backward] of [['forward -P39', 39, false], ['backward -P39', 39, true], ['-P+16', 55, false], ['-P-32', 7, false], ['-P0', 0, false]] as const) {
    it(`decrunches Brokkr's raw stream (${name})`, () => {
      const r = raw(data, { backward, crunch: { protocol: { flags } } });
      writeFileSync(join(dir, 'b.bin'), r.bytes);
      exo('raw', '-q', '-d', `-P${flags}`, ...(backward ? ['-b'] : []), '-o', join(dir, 'back.bin'), join(dir, 'b.bin'));
      expect(new Uint8Array(readFileSync(join(dir, 'back.bin')))).toEqual(data);
    });
  }

  it('Brokkr reads the stream Exomizer writes', () => {
    writeFileSync(join(dir, 'in.bin'), data);
    exo('raw', '-q', '-o', join(dir, 'e.bin'), join(dir, 'in.bin'));
    expect(readStream(new Uint8Array(readFileSync(join(dir, 'e.bin'))), 39).data).toEqual(data);
  });

  it('crunches smaller than Exomizer', () => {
    writeFileSync(join(dir, 'in.bin'), data);
    exo('raw', '-q', '-o', join(dir, 'e.bin'), join(dir, 'in.bin'));
    expect(raw(data).bytes.length).toBeLessThanOrEqual(readFileSync(join(dir, 'e.bin')).length);
  });
});

