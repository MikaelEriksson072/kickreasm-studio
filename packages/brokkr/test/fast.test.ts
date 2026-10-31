import { describe, expect, it } from 'vitest';
import { assemble } from '../src/asm.ts';
import { decrunchSource } from '../src/decruncher.ts';
import { Machine } from '../src/emulate.ts';
import { crunchFast, readFast, writeFast } from '../src/fast.ts';
import { fastDecrunchSource } from '../src/fast-decruncher.ts';
import { mem, memFast, rawFast } from '../src/files.ts';
import { LIT, MATCH, type Tokens } from '../src/format.ts';
import { sfx } from '../src/sfx.ts';
import { basicProgram, programLike, rng } from './tools.ts';

/** Decrunch a mem file in the emulated C64 with a decruncher whose `stream` takes the file's end, at $c000. */
function runDecruncher(source: string, file: Uint8Array): { m: Machine; cycles: number } {
  const code = assemble(source);
  const m = new Machine();
  m.port = 0x34;
  m.ram.set(code.bytes, code.start);
  const load = file[0] | (file[1] << 8), body = file.subarray(2), end = load + body.length;
  m.ram.set(body, load);
  const stream = code.labels.stream;
  const caller = assemble(`* = $cf00
        lda #<${end}
        sta ${stream}
        lda #>${end}
        sta ${stream + 1}
        jsr ${code.labels.decrunch}
stop:   jmp stop`);
  m.ram.set(caller.bytes, caller.start);
  const r = m.run(0xcf00, pc => pc === caller.labels.stop, 100_000_000);
  expect(m.trouble).toEqual([]);
  expect(r.stopped).toBe(true);
  return { m, cycles: r.cycles };
}

const tokens = (list: [number, number, number][]): Tokens => ({
  kind: Uint8Array.from(list.map(t => t[0])), len: Int32Array.from(list.map(t => t[1])), off: Int32Array.from(list.map(t => t[2])), count: list.length,
});

describe("Brokkr's fast format", () => {
  const data = programLike(20000, 31);

  it('decrunches what it crunches', () => {
    expect(readFast(crunchFast(data).stream).data).toEqual(data);
    const noise = rng(6);
    for (const d of [new Uint8Array([7]), new Uint8Array(3000), Uint8Array.from({ length: 3000 }, () => Math.floor(noise() * 256))]) {
      expect(readFast(crunchFast(d).stream).data).toEqual(d);
    }
  });

  it('takes every kind of token, lengths over 255 and offsets up to 65535', () => {
    // a literal run over 32, a run of 65503 at offset 1, then: a tiny, a mid and a long match, the last offset again
    // after a literal and after a match (over 255), and a match 65535 bytes back
    const list: [number, number, number][] = [[LIT, 40, 0], [MATCH, 65495, 1], [LIT, 1, 0], [MATCH, 2, 16], [MATCH, 3, 9],
      [MATCH, 9, 4096], [MATCH, 40, 4097], [LIT, 2, 0], [MATCH, 300, 4097], [MATCH, 1, 4097], [MATCH, 5, 65535], [LIT, 3, 0]];
    const r = rng(10), d = new Uint8Array(list.reduce((s, t) => s + t[1], 0));
    let p = 0;
    for (const [k, l, o] of list) {
      for (let i = 0; i < l; i++) d[p + i] = k === MATCH ? d[p + i - o] : Math.floor(r() * 256);
      p += l;
    }
    expect(readFast(writeFast(d, tokens(list))).data).toEqual(d);
  });

  it('mem files decrunch in place with its 6502 decruncher, faster than Exomizer\'s format with Brokkr\'s', () => {
    const r = memFast(data, 0x1000);
    expect(r.at).toEqual(r.inPlace);
    expect(r.inPlace.start).toBe(0x1000 - r.fast.safety);
    const fast = runDecruncher(fastDecrunchSource({ at: 0xc000 }), r.bytes);
    expect(fast.m.ram.subarray(0x1000, 0x1000 + data.length)).toEqual(data);
    const exo = runDecruncher(decrunchSource({ at: 0xc000 }), mem(data, 0x1000).bytes);
    expect(fast.cycles).toBeLessThan(exo.cycles * 0.75);
  });

  it('raw files reverse the stream with -r', () => {
    const d = programLike(3000, 12);
    expect(rawFast(d, { reversed: true }).bytes).toEqual(rawFast(d).bytes.slice().reverse());
  });

  it('self-extracting files start the program, decrunched faster, with the decruncher in the stack page', () => {
    for (const start of ['sys', 'basic'] as const) {
      const prg = basicProgram(programLike(30000, 3));
      const f = sfx(prg, 0x0801, { format: 'fast', start });
      const e = sfx(prg, 0x0801, { start });
      expect(f.format).toBe('fast');
      expect(f.effect).toBe(false);
      expect(f.areas.find(a => a.name === 'Decruncher')!.start).toBe(0x0100);
      expect(f.cycles).toBeLessThan(e.cycles * 0.75);
    }
  });
});
