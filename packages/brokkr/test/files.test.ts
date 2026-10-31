import { describe, expect, it } from 'vitest';
import { assemble } from '../src/asm.ts';
import { decrunchSource } from '../src/decruncher.ts';
import { Machine } from '../src/emulate.ts';
import { mem, raw } from '../src/files.ts';
import { readStream } from '../src/format.ts';
import { programLike } from './tools.ts';

/** Decrunch a mem file in the emulated C64 with Brokkr's own decruncher for programs (at $c000). */
function runDecruncher(file: Uint8Array, o: { four?: boolean } = {}): { m: Machine; cycles: number } {
  const code = assemble(decrunchSource({ at: 0xc000, four: o.four }));
  const m = new Machine();
  m.port = 0x35;
  m.ram.set(code.bytes, code.start);
  const load = file[0] | (file[1] << 8), body = file.subarray(2), end = load + body.length;
  m.ram.set(body, load);
  // a caller: the stream's end in `stream`, then jsr decrunch, then stop at $c800
  const stream = code.labels.stream;
  const caller = assemble(`* = $c800
        lda #<${end}
        sta ${stream}
        lda #>${end}
        sta ${stream + 1}
        jsr ${code.labels.decrunch}
stop:   jmp stop`);
  m.ram.set(caller.bytes, caller.start);
  const r = m.run(0xc800, pc => pc === caller.labels.stop, 50_000_000);
  expect(m.trouble).toEqual([]);
  expect(r.stopped).toBe(true);
  return { m, cycles: r.cycles };
}

describe('mem files', () => {
  const data = programLike(20000, 11);

  it('decrunch in place with Brokkr\'s decruncher for programs', () => {
    const r = mem(data, 0x1000);
    expect(r.at).toEqual(r.inPlace);
    expect(r.inPlace.start).toBe(0x1000 - r.crunched.safety);
    const { m } = runDecruncher(r.bytes);
    expect(m.ram.subarray(0x1000, 0x1000 + data.length)).toEqual(data);
  });

  it('with a table for length 3 too', () => {
    const r = mem(data, 0x1000, { crunch: { protocol: { flags: 55 } } });
    const { m } = runDecruncher(r.bytes, { four: true });
    expect(m.ram.subarray(0x1000, 0x1000 + data.length)).toEqual(data);
  });

  it('are Exomizer\'s format: the end address after a backward stream, the start before a forward one', () => {
    const back = mem(data, 0x2000, { load: 'none' });
    const n = back.bytes.length;
    expect(back.bytes[n - 2] | (back.bytes[n - 1] << 8)).toBe(0x2000 + data.length);
    expect(readStream(back.bytes.subarray(0, n - 2).slice().reverse(), 39).data).toEqual(data.slice().reverse());
    const fwd = mem(data, 0x2000, { forward: true, load: 'none' });
    expect((fwd.bytes[0] << 8) | fwd.bytes[1]).toBe(0x2000);
    expect(readStream(fwd.bytes.subarray(2), 39).data).toEqual(data);
    expect(fwd.inPlace.end).toBe(0x2000 + data.length + fwd.crunched.safety);
  });

  it('warn when a load address given makes the decruncher write over what it has not read', () => {
    const r = mem(data, 0x1000, { load: 0x1100 });
    expect(r.warnings.join()).toMatch(/must start at/);
  });

  it('use -T4 by default, for exodecrunch.s', () => {
    const runs = new Uint8Array(5000).fill(1);
    expect(mem(runs, 0x1000).crunched.stats.traits & 4).toBe(0);
  });
});

describe('raw files', () => {
  it('reverse the stream with -r', () => {
    const data = programLike(3000, 12);
    const a = raw(data), b = raw(data, { reversed: true });
    expect(b.bytes).toEqual(a.bytes.slice().reverse());
  });
});
