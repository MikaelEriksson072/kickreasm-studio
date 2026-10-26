/* The built-in Kick-subset assembler's preprocessor (#define/#undef/#if/#elif/#else/#endif). */
import { describe, expect, it } from 'vitest';
import { assemble } from '../src';

const bytes = (src: string) => { const r = assemble({ 'a.asm': src }, 'a.asm'); expect(r.errors).toEqual([]); return [...r.mem.subarray(0x1000, 0x1000 + r.max - 0x1000 + 1)]; };

describe('text encodings', () => {
  // the bytes KickAss 5.25 writes for these strings (measured with KickAss.jar)
  const enc = (name: string, text: string) => bytes(`.pc = $1000\n.encoding "${name}"\n.text "${text}"`);
  it('match Kick Assembler for mapped and passed-through characters', () => {
    expect(enc('screencode_upper', '@AZ[]az^_`\\{~ 0?')).toEqual([0x00, 0x01, 0x1a, 0x1b, 0x1d, 0x61, 0x7a, 0x5e, 0x5f, 0x60, 0x5c, 0x7b, 0x7e, 0x20, 0x30, 0x3f]);
    expect(enc('screencode_mixed', '@azAZ[]^\\')).toEqual([0x00, 0x01, 0x1a, 0x41, 0x5a, 0x1b, 0x1d, 0x5e, 0x5c]);
    expect(enc('petscii_upper', '@AZaz^')).toEqual([0x40, 0x41, 0x5a, 0x61, 0x7a, 0x5e]);
    expect(enc('petscii_mixed', '@azAZ[{')).toEqual([0x40, 0x41, 0x5a, 0xc1, 0xda, 0x5b, 0x7b]);
  });
});

describe('preprocessor', () => {
  it('assembles only the branches whose condition holds', () => {
    const src = (defs: string) => `${defs}\n.pc = $1000\n#if A\n.byte 1\n#elif B && !C\n.byte 2\n#else\n.byte 3\n#endif\n.byte 9`;
    expect(bytes(src('#define A'))).toEqual([1, 9]);
    expect(bytes(src('#define B'))).toEqual([2, 9]);
    expect(bytes(src('#define B\n#define C'))).toEqual([3, 9]);
    expect(bytes(src('#define A\n#undef A\n#define B'))).toEqual([2, 9]);
    expect(bytes(src('#define C'))).toEqual([3, 9]);
  });

  it('nests, ignores #define in skipped branches, and skips #import there', () => {
    const r = assemble({ 'a.asm': '.pc = $1000\n#if X\n#define Y\n#import "missing.asm"\n#endif\n#if (X || !Y) && true\n.byte 7\n#endif', 'b.asm': '' }, 'a.asm');
    expect(r.errors).toEqual([]);
    expect(r.mem[0x1000]).toBe(7);
  });

  it('reports unbalanced directives', () => {
    expect(assemble({ 'a.asm': '#if A\n.byte 1' }, 'a.asm').errors.map(e => e.msg)).toContain('#if without #endif (1 open)');
    expect(assemble({ 'a.asm': '#endif' }, 'a.asm').errors.map(e => e.msg)).toContain('#endif without #if');
  });
});
