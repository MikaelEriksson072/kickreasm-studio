import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble } from '../src/asm.ts';
import { brkDecrunchSource } from '../src/brk-decruncher.ts';
import { decrunchSource } from '../src/decruncher.ts';
import { JAVA, KICKASS } from './tools.ts';

describe('the assembler', () => {
  it('assembles every addressing mode, zero page where it can', () => {
    const r = assemble(`* = $1000
start:  lda #$12
        sta $fb
        sta $0400,x
        lda ($fb),y
        lda ($fb,x)
        ldx $fe,y
        jmp ($0314)
        asl
        bne start
        .byte <start, >start, 1+2*3
        .word start`);
    expect([...r.bytes]).toEqual([0xa9, 0x12, 0x85, 0xfb, 0x9d, 0x00, 0x04, 0xb1, 0xfb, 0xa1, 0xfb, 0xb6, 0xfe, 0x6c, 0x14, 0x03, 0x0a, 0xd0, 0xed, 0x00, 0x10, 7, 0x00, 0x10]);
    expect(r.labels.start).toBe(0x1000);
  });

  it('takes .if and else blocks, nested, and constants from outside', () => {
    const src = `* = $2000
.if (A == 1) {
  .if (B > 2) {
        .byte 1
  } else {
        .byte 2
  }
} else {
        .byte 3
}
.const C = A ? 4 : 5
        .byte C`;
    expect([...assemble(src, { A: 1, B: 3 }).bytes]).toEqual([1, 4]);
    expect([...assemble(src, { A: 1, B: 0 }).bytes]).toEqual([2, 4]);
    expect([...assemble(src, { A: 0, B: 0 }).bytes]).toEqual([3, 5]);
  });

  it('says what is wrong, and on which line', () => {
    expect(() => assemble('* = $1000\n  lda missing')).toThrow(/line 2: "missing" names a label/);
    expect(() => assemble('* = $1000\nl: .fill 200, 0\n  bne l')).toThrow(/line 3: the branch .* more than a branch reaches/);
    expect(() => assemble('* = $1000\n  foo #1')).toThrow(/line 2: "foo #1" is not an instruction/);
    expect(() => assemble('.if (1) {\n  nop')).toThrow(/not closed/);
  });
});

describe.skipIf(!KICKASS || !JAVA)('against Kick Assembler', () => {
  const same = (src: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'brokkr-kick-'));
    writeFileSync(join(dir, 'd.asm'), src);
    execFileSync(JAVA!, ['-jar', KICKASS!, join(dir, 'd.asm'), '-o', join(dir, 'd.prg')], { stdio: 'pipe' });
    const kick = new Uint8Array(readFileSync(join(dir, 'd.prg')));
    const ours = assemble(src);
    expect(kick[0] | (kick[1] << 8)).toBe(ours.start);
    expect(kick.subarray(2)).toEqual(ours.bytes);
  };
  for (const [name, o] of [['default', {}], ['four tables, effect', { four: true, effect: true }], ['no reuse, no sequences', { reuse: false, literalSequences: false }]] as const) {
    it(`assembles the decruncher to the same bytes (${name})`, () => same(decrunchSource({ ...o, at: 0xc000 })));
  }
  for (const [name, o] of [['quarter squares', {}], ['shift and add, effect', { small: true, effect: true }]] as const) {
    it(`assembles the decruncher of Brokkr's own format to the same bytes (${name})`, () => same(brkDecrunchSource({ ...o, at: 0xc000 })));
  }
});
