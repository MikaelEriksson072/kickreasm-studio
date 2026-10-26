/* 6510 cycle counts and the cycles of a path through a range (spec 10.1). */
import { describe, expect, it } from 'vitest';
import { analyze, cyclePath, cycleText, instructionCycles, OPC, type AnalysisResult } from '../src';
import { fromSource } from './helpers/programs';

/** the cycles of opcode `op` with operand bytes `lo hi` placed at $1000 */
const at = (op: number, lo = 0x12, hi = 0x34, pc = 0x1000) => { const mem = new Uint8Array(0x10000); mem.set([op, lo, hi], pc); return instructionCycles(mem, pc); };

const program = (src: string): AnalysisResult => analyze({ name: 't', files: [fromSource('t.prg', `.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n${src}`)] });

describe('instruction cycles', () => {
  it('follow the addressing mode and access of every opcode', () => {
    // the NMOS rules, from the opcode table: a second source for the hand-written cycle table
    const rule = (o: typeof OPC[number]) => {
      if (o.jam) return 0;
      if (o.flow === 'br') return 2;
      if (o.flow === 'jsr') return 6;
      if (o.flow === 'jmp') return 3;
      if (o.flow === 'jmpi') return 5;
      if (o.flow === 'ret') return 6;
      if (o.flow === 'brk') return 7;
      const rmw = o.access === 'rmw', write = o.access === 'write';
      switch (o.mode) {
        case 'imp': case 'acc': return o.mn === 'PHA' || o.mn === 'PHP' ? 3 : o.mn === 'PLA' || o.mn === 'PLP' ? 4 : 2;
        case 'imm': return 2;
        case 'zp': return rmw ? 5 : 3;
        case 'zpx': case 'zpy': return rmw ? 6 : 4;
        case 'abs': return rmw ? 6 : 4;
        case 'abx': case 'aby': return rmw ? 7 : write ? 5 : 4;
        case 'izx': return rmw ? 8 : 6;
        case 'izy': return rmw ? 8 : write ? 6 : 5;
        default: return -1;
      }
    };
    for (const o of OPC) {
      const c = at(o.op);
      expect(c.base, `${o.mn} ${o.mode} ($${o.op.toString(16)})`).toBe(rule(o));
      expect(c.page, `page crossing of ${o.mn} ${o.mode}`).toBe(o.access === 'read' && (o.mode === 'abx' || o.mode === 'aby' || o.mode === 'izy'));
    }
  });

  it('match the well-known counts', () => {
    const t = (op: number, lo?: number, hi?: number) => cycleText(at(op, lo, hi));
    expect([t(0xa9), t(0xad), t(0xbd), t(0x9d), t(0xfe), t(0x20), t(0x60), t(0x6c), t(0x00), t(0xb3), t(0xdf), t(0x02)])
      .toEqual(['2', '4', '4+', '5', '7', '6', '6', '5', '7', '5+', '7', '—']);
    // $1000,x cannot leave $10xx: no extra cycle; ($12),y depends on the pointer, so it can
    expect([t(0xbd, 0x00, 0x10), t(0xb9, 0x00, 0x10), t(0xb1, 0x00)]).toEqual(['4', '4', '5+']);
  });

  it('give a branch 3 cycles when taken, 4 when its target is in another page', () => {
    expect(cycleText(at(0xd0, 0x05))).toBe('2/3');
    expect(cycleText(at(0xd0, 0xfb))).toBe('2/4'); // $1002 - 5 = $0ffd
    expect(cycleText(at(0xf0, 0x02, 0, 0x10fc))).toBe('2/4'); // $10fe + 2 = $1100
  });
});

describe('cycle path', () => {
  const A = program([
    ' ldx #$00', // $080d 2
    ' lda $1000,x', // $080f 4
    ' lda $10f0,x', // $0812 4+
    ' cmp #$05', // $0815 2
    ' bne skip', // $0817 2/3
    ' inc $d020', // $0819 6
    ' nop', // $081c 2
    'skip:',
    ' jsr sub', // $081d 6
    ' ldy #$03', // $0820 2
    'loop:',
    ' dey', // $0822 2
    ' bne loop', // $0823 2/3
    ' jmp done', // $0825 3
    ' nop', // $0828 2 (skipped by the jmp)
    'done:',
    ' rts', // $0829 6
    ' nop', // $082a (after the return)
    'sub:',
    ' rts',
  ].join('\n'));
  const range = [0x080d, 0x082b] as const;

  it('counts one pass with no branch taken', () => {
    const p = cyclePath(A, ...range, new Set());
    expect(p.straight).toBe(2 + 4 + 4 + 2 + 2 + 6 + 2 + 6 + 2 + 2 + 2 + 3 + 6);
    expect(p.total).toBe(p.straight);
    expect(p.pageMax).toBe(1);
    expect(p.calls).toBe(1);
    // the nops after the jmp and the rts are never reached: they are not code, so not counted
    expect(p.steps.map(s => s.pc)).not.toContain(0x0828);
    expect(p.steps.filter(s => !s.counted)).toEqual([]);
    expect(p.steps.find(s => s.pc === 0x0820)!.sum).toBe(2 + 4 + 4 + 2 + 2 + 6 + 2 + 6 + 2);
  });

  it('skips what a taken forward branch jumps over, and says what each branch would change', () => {
    const p = cyclePath(A, ...range, new Set([0x0817]));
    expect(p.total).toBe(p.straight + 1 - 8); // the taken bne costs one more and skips inc + nop
    expect(p.steps.filter(s => !s.counted).map(s => s.pc)).toEqual([0x0819, 0x081c]);
    const [bne, loop] = p.branches;
    expect(bne).toMatchObject({ pc: 0x0817, target: 0x081d, notTaken: 2, taken: 3, on: true, onPath: true, back: false, leaves: false, other: p.straight });
    // a loop is not repeated: one more pass is dey and the taken bne
    expect(loop).toMatchObject({ pc: 0x0823, target: 0x0822, back: true, on: false, other: p.total + 1, pass: 2 + 3 });
  });

  it('ends at a branch out of the range', () => {
    const p = cyclePath(A, 0x080d, 0x081d, new Set([0x0817]));
    expect(p.branches[0]).toMatchObject({ leaves: true, on: true });
    expect(p.total).toBe(2 + 4 + 4 + 2 + 3);
    expect(p.steps.filter(s => !s.counted).map(s => s.pc)).toEqual([0x0819, 0x081c]);
  });
});
