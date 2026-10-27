/* 5.4b timing code: a branch the code points into a delay by a timer, to make a raster stable. */
import { describe, expect, it } from 'vitest';
import { analyze, openC64File, render, verify, type FileInput, type Line } from '../src';
import { fromSource, snapshotOf } from './helpers/programs';

// the IRQ of a stable raster: CIA 1's timer B low byte, turned around, is how far the BPL goes into the delay
const STABLE = (enter = 0) => `.pc = $c000
irq: lda $dc06
 eor #$07
 sta smc+1
smc: bpl delay${enter ? `+${enter}` : ''}
delay: lda #$a9
 lda #$a9
 lda $eaa5
 stx $03
 sty $04
 asl $d019
 rti
`;
function run(file: FileInput, entries: number[]) {
  const p = { name: 't', files: [file], entries };
  const A = analyze(p), R = render(A, p);
  expect(verify(A, R).ok).toBe(true);
  const lines = R.fileLines[`${R.fileNames[0]}.asm`];
  const ins = (a: number) => lines.find(l => l.k === 'ins' && l.a === a) as Extract<Line, { k: 'ins' }> | undefined;
  return { A, R, lines, ins, src: R.files[`${R.fileNames[0]}.asm`] as string };
}
const snapshot = (src: string) => openC64File('snap.vsf', snapshotOf(src, 0xc000));

describe('timing code', () => {
  it('finds a branch a timer points into a delay, and marks the delay instead of naming what it reads', () => {
    const o = snapshot(STABLE());
    const { A, ins, src } = run(o, o.entries!);
    expect(A.delays).toEqual([{ branch: 0xc008, by: 0xc005, read: 0xc000, timer: 0xdc06, start: 0xc00a, end: 0xc011, enter: 0, most: 7, cycles: [0, 8], ins: [0xc00a, 0xc00c, 0xc00e] }]);
    // no label for what the delay reads, which is RAM in a snapshot ($eaa5) or the zero page
    expect(A.labels.has(0xeaa5)).toBe(false);
    expect(A.labels.get(0xc00a)?.name).toBe('delay_c00a');
    expect(ins(0xc00e)).toMatchObject({ mn: 'LDA', tok: [{ t: 'num', s: '$eaa5' }], cmt: 'delay', delay: true });
    expect(ins(0xc008)?.cmt).toBe('self-modified by $c005; 0-7 bytes into the delay, by CIA1_TB_LO ($dc06)');
    expect(src).toContain('// delay: the bpl at $c008 goes 0-7 bytes into it by CIA1_TB_LO ($dc06), so it takes 8 down to 0 cycles\ndelay_c00a:');
    expect(src).toMatch(/bpl delay_c00a\s/);
    expect(A.log.some(l => l.msg === 'Timing code at $c008: the BPL is set from CIA1_TB_LO ($dc06) at $c000, and enters the delay at $c00a-$c010 0-7 bytes in: 8 down to 0 cycles, to make the timing stable')).toBe(true);
    // the code after the delay is code as usual
    expect(ins(0xc011)).toMatchObject({ mn: 'STX', cmt: '' });
  });

  it('decodes the delay from its start when the snapshot holds another way in', () => {
    const o = snapshot(STABLE(5));
    const { A, ins, src } = run(o, o.entries!);
    expect(A.delays[0]).toMatchObject({ start: 0xc00a, enter: 5, ins: [0xc00a, 0xc00c, 0xc00e] });
    expect(ins(0xc00a)?.mn).toBe('LDA');
    expect(src).toMatch(/bpl delay_c00a\+5\s/);
  });

  it('leaves a branch set from anything but a counter, or without a delay that every way in ends in, as it was', () => {
    for (const src of [
      STABLE().replace('lda $dc06', 'lda $c100'), // a variable, not a timer
      STABLE().replace(' eor #$07\n', ''), // no limit to how far it goes
      STABLE().replace('lda #$a9\n lda #$a9', 'lda #$a9\n sta $0400'), // a store in it
    ]) {
      const o = snapshot(src);
      expect(run(o, o.entries!).A.delays, src).toEqual([]);
    }
    // a PRG too: the timer is the VIC's raster, the limit an AND
    const f = fromSource('p.prg', `.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n lda $d012\n and #$03\n sta b+1\nb: bne d\nd: cmp #$c9\n nop\n rts\n`);
    expect(run(f, []).A.delays).toMatchObject([{ timer: 0xd012, most: 3, cycles: [0, 4] }]);
  });
});
