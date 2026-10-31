import { describe, expect, it } from 'vitest';
import { assemble } from '../src/asm.ts';
import { brkDecrunchSource } from '../src/brk-decruncher.ts';
import { readBrk, writeBrk } from '../src/brk.ts';
import { crunchBrk } from '../src/crunch-brk.ts';
import { crunchData } from '../src/crunch.ts';
import { Machine } from '../src/emulate.ts';
import { memBrk, rawBrk } from '../src/files.ts';
import { LIT, MATCH } from '../src/format.ts';
import { sfx } from '../src/sfx.ts';
import { basicProgram, programLike, rng } from './tools.ts';

/** Decrunch a mem file of Brokkr's own format in the emulated C64 with its decruncher at $c000 (tables at $a000). */
function runDecruncher(file: Uint8Array, small: boolean): { m: Machine; cycles: number } {
  const code = assemble(brkDecrunchSource({ at: 0xc000, table: 0xa000, small }));
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
  const r = m.run(0xcf00, pc => pc === caller.labels.stop, 400_000_000);
  expect(m.trouble).toEqual([]);
  expect(r.stopped).toBe(true);
  return { m, cycles: r.cycles };
}

describe("Brokkr's own format", () => {
  const data = programLike(20000, 21);

  it('decrunches what it crunches, smaller than Exomizer\'s format', () => {
    const b = crunchBrk(data);
    expect(readBrk(b.stream).data).toEqual(data);
    expect(b.stream.length).toBeLessThan(crunchData(data).stream.length);
    const noise = rng(5);
    for (const d of [new Uint8Array([7]), new Uint8Array(3000), Uint8Array.from({ length: 3000 }, () => Math.floor(noise() * 256))]) {
      expect(readBrk(crunchBrk(d).stream).data).toEqual(d);
    }
  });

  it('takes every length and offset, and the last offset again after literals', () => {
    const n = 70000, d = new Uint8Array(n);
    const r = rng(9);
    for (let i = 0; i < n; i++) d[i] = Math.floor(r() * 256);
    // literals, then a long run, a far match, a rep after a literal
    const tokens = { kind: Uint8Array.from([LIT, MATCH, LIT, MATCH, LIT, MATCH, MATCH]), len: Int32Array.from([1000, 40000, 1, 2, 3, 20000, 1]), off: Int32Array.from([0, 1, 0, 1, 0, 33000, 7]), count: 7 };
    let pos = 0;
    for (let t = 0; t < tokens.count; t++) {
      if (tokens.kind[t] === MATCH) for (let k = 0; k < tokens.len[t]; k++) d[pos + k] = d[pos + k - tokens.off[t]];
      pos += tokens.len[t];
    }
    expect(readBrk(writeBrk(d.subarray(0, pos), tokens)).data).toEqual(d.subarray(0, pos));
  });

  for (const small of [false, true]) {
    it(`mem files decrunch in place with its 6502 decruncher${small ? ' (shift and add)' : ''}`, () => {
      const r = memBrk(data, 0x1000);
      expect(r.at).toEqual(r.inPlace);
      expect(r.inPlace.start).toBe(0x1000 - r.brk.safety);
      const { m } = runDecruncher(r.bytes, small);
      expect(m.ram.subarray(0x1000, 0x1000 + data.length)).toEqual(data);
    });
  }

  it('raw files reverse the stream with -r', () => {
    const d = programLike(3000, 12);
    expect(rawBrk(d, { reversed: true }).bytes).toEqual(rawBrk(d).bytes.slice().reverse());
  });

  it('self-extracting files start the program, smaller than Exomizer\'s format for a bigger one', () => {
    const prg = basicProgram(programLike(30000, 3));
    const b = sfx(prg, 0x0801, { format: 'brokkr' });
    const e = sfx(prg, 0x0801);
    expect(b.format).toBe('brokkr');
    expect(b.areas.map(a => a.name)).toContain('Probabilities');
    expect(b.prg.length).toBeLessThan(e.prg.length);
  });

  it("self-extracting files fall back to Exomizer's format when the program leaves no room", () => {
    const prg = basicProgram(programLike(0xffe0 - 0x080d, 6));
    const r = sfx(prg, 0x0801, { format: 'brokkr' });
    expect(r.format).toBe('exomizer');
    expect(r.warnings.join()).toMatch(/no room for the probabilities/);
    expect(() => sfx(prg, 0x0801, { format: 'brokkr', fallback: false })).toThrow(/no room for the decruncher .* its probabilities/);
  });
});
