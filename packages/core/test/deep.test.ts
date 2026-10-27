/* 5.17 deep analysis: every rule on a small program that the normal analysis reports problems for. */
import { describe, expect, it } from 'vitest';
import { analyze, findBlock, openC64File, render, verify, type FileInput, type ProjectInput } from '../src';
import { fromSource, snapshotOf } from './helpers/programs';

const BASIC = '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n';
const problems = (A: ReturnType<typeof analyze>) => A.log.filter(l => l.lvl === 'warn' || l.lvl === 'err' || l.lvl === 'hint');
const deepLines = (A: ReturnType<typeof analyze>) => A.log.filter(l => l.cat === 'deep').map(l => l.msg);
/** The normal and the deep analysis of the same project, both checked to assemble back to the same bytes. */
function both(file: FileInput, extra: Partial<ProjectInput> = {}) {
  const out = [false, true].map(deepAnalysis => {
    const p: ProjectInput = { name: 't', files: [file], ...extra, settings: { ...extra.settings, deepAnalysis } };
    const A = analyze(p), R = render(A, p);
    expect(verify(A, R).ok).toBe(true);
    return A;
  });
  return { normal: out[0], deep: out[1] };
}
const snapshot = (src: string, pc: number) => { const o = openC64File('snap.vsf', snapshotOf(src, pc)); return { file: o as FileInput, extra: { entries: o.entries } }; };

describe('deep analysis', () => {
  it('is off by default, and reports what it did when on', () => {
    const { normal, deep } = both(fromSource('p.prg', `${BASIC} lda #1\n sta $d020\n bne go\n .byte $02,$00\ngo: rts\n`));
    expect(normal.deep).toBeNull();
    expect(problems(normal).map(l => l.msg)).toEqual(['JAM opcode $02 reached at $0814; the path probably runs into data']);
    expect(problems(deep)).toEqual([]);
    expect(deep.deep).toMatchObject({ before: 1, after: 0, branches: 1 });
    expect(deepLines(deep).at(-1)).toMatch(/^Deep analysis: 1 → 0 problems in \d rounds?: 0 guesses left out, 0 calls and jumps not followed, 1 branch decided by the flags before it$/);
  });

  it('follows only the side of a branch the flags before it take, through instructions that keep them', () => {
    // lda #1 / sta: Z = 0, so BNE always branches and BEQ never does
    const { deep } = both(fromSource('p.prg', `${BASIC} lda #1\n sta $d020\n beq never\n bne go\nnever: .byte $02\ngo: clc\n bcc done\n .byte $00\ndone: rts\n`));
    expect(problems(deep)).toEqual([]);
    expect(deep.insLen[0x0816]).toBe(0);
    expect(deep.insLen[0x081a]).toBe(0);
    expect(deep.deep!.branches).toBe(3);
  });

  it('follows both sides again when the branch is reached some other way', () => {
    // `again` is a branch target: from there the flags are unknown
    const src = `${BASIC} lda #1\nagain: bne go\n .byte $ea\n rts\ngo: ldx $02\n beq again\n rts\n`;
    const { deep } = both(fromSource('p.prg', src));
    expect(deep.insLen[0x0811]).toBe(1); // the NOP after the BNE is code
    expect(deep.deep!.branches).toBe(0);
  });

  it('keeps a code island only when tracing it runs into no problem', () => {
    const src = `${BASIC} rts\nbad: lda #0\n sta $d020\n jsr junk\n lda #1\n sta $d021\n rts\ngood: lda #2\n sta $d020\n ldx #0\n stx $d021\n inx\n rts\njunk: .byte $02,$02,$02\n`;
    const { normal, deep } = both(fromSource('p.prg', src));
    expect(findBlock(normal.blocks, 0x080e)?.type).toBe('code');
    expect(problems(normal).some(l => l.msg.startsWith('JAM'))).toBe(true);
    expect(findBlock(deep.blocks, 0x080e)?.type).toBe('data');
    expect(findBlock(deep.blocks, 0x081c)).toMatchObject({ type: 'code', start: 0x081c });
    expect(problems(deep)).toEqual([]);
    expect(deepLines(deep)).toContain('The routine-like bytes at $080e stay data: traced on trial, they run into a problem (JAM opcode $02 reached at $0828)');
  });

  it('does not follow a call into the KERNAL ROM of a snapshot, nor its IRQ vector at $ea31', () => {
    // the RAM below the KERNAL is zeros; $01 = $37
    const { file, extra } = snapshot(`.pc = $c000\nloop: jsr $ffe4\n beq loop\n sei\n lda #$31\n sta $0314\n lda #$ea\n sta $0315\n cli\nwait: jmp wait\n`, 0xc000);
    const { normal, deep } = both(file, extra);
    expect(problems(normal).length).toBeGreaterThan(0);
    expect(problems(deep)).toEqual([]);
    expect(deep.insLen[0xffe4]).toBe(0);
    expect(deep.insLen[0xea31]).toBe(0);
    expect(deepLines(deep)).toEqual(expect.arrayContaining([
      'The JSR at $c000 to $ffe4 reaches the KERNAL ROM there, so the RAM below it is not traced',
      'IRQ vector $0314 set to $ea31 at $c006: the KERNAL ROM\'s own routine, so the RAM below is not traced',
      'The load address $0200 is not used as the entry point: traced on trial, it runs into a problem (BRK at $0200 ends the code path)',
    ]));
  });

  it('keeps an IRQ handler that ends in JMP $ea31, with the KERNAL ROM there', () => {
    const { file, extra } = snapshot(`.pc = $c000\n sei\n lda #<irq\n sta $0314\n lda #>irq\n sta $0315\n cli\nwait: jmp wait\nirq: inc $d020\n asl $d019\n jmp $ea31\n`, 0xc000);
    const { deep } = both(file, extra);
    expect(deep.entryKind.get(0xc00f)).toBe('irq');
    expect(findBlock(deep.blocks, 0xc00f)?.type).toBe('code');
    expect(deep.insLen[0xea31]).toBe(0);
    expect(problems(deep)).toEqual([]);
  });

  it('does not follow a JMP whose address the code writes', () => {
    const src = `${BASIC} lda #<target\n sta jump+1\n lda #>target\n sta jump+2\njump: jmp $0830\ntarget: rts\n.pc = $0830\n .byte $02,$02\n`;
    const { normal, deep } = both(fromSource('p.prg', src));
    expect(problems(normal).some(l => l.msg.startsWith('JAM'))).toBe(true);
    expect(problems(deep)).toEqual([]);
    expect(deepLines(deep)).toContain('The code at $080f writes the address of the JMP at $0817, so its target $0830 is set at run time and is not followed');
  });

  it('does not trace the bytes after a JSR to a routine that never returns', () => {
    const src = `${BASIC} jsr forever\n .byte $02,$02\nforever: inc $d020\n jmp forever\n`;
    const { normal, deep } = both(fromSource('p.prg', src));
    expect(problems(normal).length).toBe(1);
    expect(problems(deep)).toEqual([]);
    expect(deep.insLen[0x0810]).toBe(0);
    expect(deepLines(deep)).toContain('The routine at $0812 never returns, so the bytes after the JSR at $080d are not traced');
  });

  it('does not follow a call to a routine that is not there yet, nor run into an instruction code writes', () => {
    // $0900 is zeros until something unpacks a routine there; the code writes the instruction at `patch` (a NOP)
    const src = `${BASIC} jsr $0900\n lda #$ea\n sta patch\npatch: .byte $00\n rts\n.pc = $0900\n .fill 16, 0\n`;
    const { normal, deep } = both(fromSource('p.prg', src));
    expect(problems(normal).map(l => l.msg).sort()).toEqual(['BRK at $0815 ends the code path', 'BRK at $0900 ends the code path']);
    expect(problems(deep)).toEqual([]);
    expect(deepLines(deep)).toContain('The JSR at $080d goes to $0900, which holds $00: the routine is put there at run time (unpacked or copied), so it is not traced');
    expect(deep.log.some(l => l.msg === 'The code writes the instruction at $0815 ($00 now), so it is set at run time and the path stops there')).toBe(true);
    // a guess that calls into zeros is still left out
    const guess = both(fromSource('p.prg', `${BASIC} rts\n lda #0\n sta $d020\n jsr $0900\n lda #1\n sta $d021\n rts\n.pc = $0900\n .fill 16, 0\n`));
    expect(findBlock(guess.deep.blocks, 0x080e)?.type).toBe('data');
  });

  it('follows $01 through the stack and through a variable that code only stores to', () => {
    const hint = (A: ReturnType<typeof analyze>) => A.log.filter(l => l.msg.startsWith('$01 is written')).map(l => l.addr);
    // the handler saves $01 on the stack, banks the KERNAL out and back in
    const stack = `${BASIC} sei\n lda #<irq\n sta $0314\n lda #>irq\n sta $0315\n cli\n rts\nirq: lda $01\n pha\n lda #$35\n sta $01\n lda $e000\n sta $c000\n pla\n sta $01\n asl $d019\n jmp $ea31\n`;
    const s = both(fromSource('p.prg', stack));
    const restore = 0x0828; // the STA $01 after the PLA
    expect(hint(s.normal)).toEqual([restore]);
    expect(hint(s.deep)).toEqual([]);
    expect(s.deep.mcfg!.port[restore + 2] & 0x20).toBe(0); // $35 no more after it
    const variable = `${BASIC} lda $01\n sta save\n lda #$34\n sta $01\n ldx $c000\n lda save\n sta $01\n stx $0400\n rts\nsave: .byte 0\n`;
    const v = both(fromSource('p.prg', variable));
    expect(hint(v.normal)).toEqual([0x081c]);
    expect(hint(v.deep)).toEqual([]);
    // $37 again, or the byte the variable holds in the file ($00) if it is read before it is stored to
    expect(v.deep.mcfg!.port[0x081e]).toBe(1 << 7 | 1 << 0);
  });

  it('never ends with more problems than the normal analysis', () => {
    for (const src of [`${BASIC} rts\n`, `.pc = $c000\n .byte $00,$00,$a9,$01,$8d,$20,$d0,$60\n`, `${BASIC} jmp ($1234)\n`]) {
      const { normal, deep } = both(fromSource('p.prg', src));
      expect(problems(deep).length).toBeLessThanOrEqual(problems(normal).length);
      expect(deep.deep!.after).toBe(problems(deep).length);
    }
  });
});
