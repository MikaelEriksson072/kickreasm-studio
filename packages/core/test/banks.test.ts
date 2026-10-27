/* Memory configuration ($01) and VIC bank tracking (5.8b): one small program per idiom. Every case must
 * still re-assemble byte-identical; only names and comments follow what the instruction reaches. */
import { describe, expect, it } from 'vitest';
import { analyze, openC64File, render, verify, type Addr, type BankZone, type FileInput, type Line, type Settings } from '../src';
import { fromSource, snapshotOf } from './helpers/programs';

const run = (file: FileInput, extra: { bankZones?: BankZone[]; settings?: Partial<Settings>; entries?: Addr[] } = {}) => {
  const p = { name: 't', files: [file], ...extra };
  const A = analyze(p);
  const R = render(A, p);
  const V = verify(A, R);
  expect(V.ok, JSON.stringify(V.results.map(r => r.errors.concat(r.diffs as never[]).slice(0, 3)))).toBe(true);
  const lines = R.fileLines[`${R.fileNames[0]}.asm`];
  /** the instruction at `pc` as written, without its comment */
  const ins = (pc: number) => { const l = lines.find(x => x.k === 'ins' && x.a === pc) as Extract<Line, { k: 'ins' }> | undefined; return l ? `${l.mn.toLowerCase()}${l.ext} ${l.tok.map(t => t.s).join('')}`.trim() : null; };
  const cmt = (pc: number) => (lines.find(x => x.k === 'ins' && x.a === pc) as Extract<Line, { k: 'ins' }> | undefined)?.cmt ?? '';
  return { A, R, ins, cmt, src: R.files[`${R.fileNames[0]}.asm`] as string };
};
const bit = (c: number) => 1 << c;

describe('memory configuration ($01)', () => {
  it('names I/O and KERNAL accesses by the configuration they run with', () => {
    const { A, ins, cmt } = run(fromSource('p.prg', `.pc = $c000
 lda #$35
 sta $01
 sta $d020
 jsr $ffd2
 lda #$34
 sta $01
 sta $d020
 rts`));
    expect(A.mcfg!.port[0xc004]).toBe(bit(5));
    expect(ins(0xc004)).toBe('sta VIC_BORDER_COLOR'); // $35: I/O visible
    expect(ins(0xc007)).toBe('jsr $ffd2'); // $35: the KERNAL is banked out, $ffd2 is RAM
    expect(ins(0xc00e)).toBe('sta $d020'); // $34: all RAM
    expect(cmt(0xc002)).toContain('memory $35 (RAM · I/O · RAM)');
    expect(A.log.some(l => l.cat === 'memory' && l.msg === '$01 = $34 (RAM · RAM · RAM) from $c00c')).toBe(true);
  });

  it('starts with $37, so a program that never writes $01 keeps the KERNAL and I/O names', () => {
    const { A, ins } = run(fromSource('p.prg', '.pc = $c000\n sta $d020\n jsr $ffd2\n rts'));
    expect(A.mcfg!.port[0xc000]).toBe(bit(7));
    expect(ins(0xc000)).toBe('sta VIC_BORDER_COLOR');
    expect(ins(0xc003)).toBe('jsr CHROUT');
  });

  it('follows a subroutine that changes $01 back to its caller', () => {
    const { A, ins } = run(fromSource('p.prg', `.pc = $c000
 jsr init
 sta $d020
 rts
init: lda #$34
 sta $01
 rts`));
    expect(A.mcfg!.port[0xc003]).toBe(bit(4));
    expect(ins(0xc003)).toBe('sta $d020');
  });

  it('follows dec/inc $01 and lda $01 / and / ora / sta $01', () => {
    const { A, ins } = run(fromSource('p.prg', `.pc = $c000
 lda #$35
 sta $01
 dec $01
 sta $d021
 inc $01
 sta $d021
 lda $01
 and #$f8
 ora #$06
 sta $01
 jsr $ffd2
 rts`));
    expect(A.mcfg!.port[0xc006]).toBe(bit(4));
    expect(ins(0xc006)).toBe('sta $d021');
    expect(ins(0xc00b)).toBe('sta VIC_BG_COLOR0');
    expect(A.mcfg!.port[0xc016]).toBe(bit(6));
    expect(ins(0xc016)).toBe('jsr CHROUT');
  });

  it('keeps the usual name and explains it when paths with different configurations meet', () => {
    const { A, ins, cmt } = run(fromSource('p.prg', `.pc = $c000
 lda $02
 beq skip
 lda #$34
 sta $01
skip: sta $d020
 rts`));
    const at = 0xc008;
    expect(A.mcfg!.port[at]).toBe(bit(4) | bit(7));
    expect(ins(at)).toBe('sta VIC_BORDER_COLOR');
    expect(cmt(at)).toContain('RAM or I/O: $01 is $34 or $37 here');
  });

  it('names a register at $d000-$dfff as I/O when $01 cannot be told, also with RAM loaded below it', () => {
    // the program's bytes cover $d000-$d02f (as a snapshot's do): where the configuration differs, or $01 is set to
    // a value the analysis cannot follow, the store still writes the VIC register and makes no RAM label there
    const { A, ins, cmt } = run(fromSource('p.prg', `.pc = $c000
 lda $02
 beq skip
 lda #$34
 sta $01
skip: sta $d020
 lda $03
 sta $01
 sta $d012
 rts
.pc = $d000
 .fill $30, 0`));
    expect(ins(0xc008)).toBe('sta VIC_BORDER_COLOR');
    expect(cmt(0xc008)).toContain('RAM or I/O: $01 is $34 or $37 here');
    expect(A.mcfg!.port[0xc00f]).toBe(0xff);
    expect(ins(0xc00f)).toBe('sta VIC_RASTER');
    expect([...A.labels.keys()].filter(a => a >= 0xd000 && a < 0xe000)).toEqual([]);
  });

  it('narrows an interrupt handler by the vector it was installed through', () => {
    const hw = run(fromSource('p.prg', `.pc = $c000
 sei
 lda #$35
 sta $01
 lda #<irq
 sta $fffe
 lda #>irq
 sta $ffff
 cli
 jmp *
irq: sta $d019
 rti`));
    const irq = [...hw.A.entryKind].find(([, k]) => k === 'irq')![0];
    // $fffe is only used with the KERNAL out: of $37 and $35 that leaves $35
    expect(hw.A.mcfg!.port[irq]).toBe(bit(5));
    expect(hw.ins(irq)).toBe('sta VIC_IRQ_STATUS');
    const kernal = run(fromSource('p.prg', `.pc = $c000
 sei
 lda #<irq
 sta $0314
 lda #>irq
 sta $0315
 cli
 jmp *
irq: lda #$35
 sta $01
 jmp $ea31`));
    const irq2 = [...kernal.A.entryKind].find(([, k]) => k === 'irq')![0];
    expect(kernal.A.mcfg!.port[irq2]).toBe(bit(7));
  });

  it('runs an interrupt handler that acknowledges its interrupt with I/O, while the main code banks I/O out', () => {
    // the main loop switches between $35 and $34 (to reach the RAM under I/O, as a loader does); an IRQ that fired
    // with $34 could not acknowledge VIC, so the handler runs with $35
    const { A, ins, cmt } = run(fromSource('p.prg', `.pc = $c000
 sei
 lda #<irq
 sta $fffe
 lda #>irq
 sta $ffff
 lda #$35
 sta $01
 cli
loop: dec $01
 inc $01
 jmp loop
irq: pha
 lda #$20
 sta $d012
 asl $d019
 pla
 rti`));
    const irq = [...A.entryKind].find(([, k]) => k === 'irq')![0];
    expect(A.mcfg!.port[irq]).toBe(bit(5));
    expect(ins(irq + 3)).toBe('sta VIC_RASTER');
    expect(cmt(irq + 3)).not.toContain('RAM or I/O');
    expect([...A.labels.keys()].filter(a => a >= 0xd000 && a < 0xe000)).toEqual([]);
  });

  it('goes on from a snapshot with the $01 it holds, from its PC and its live interrupt vector', () => {
    // $01 = $35: the main loop reads the RAM under the KERNAL, and the handler $fffe points at writes VIC
    const src = `.pc = $c000\nloop: lda $e000\n sta $c100\n jmp loop\nirq: lda #$20\n sta $d012\n asl $d019\n rti\n.pc = $e000\n .byte $55\n.pc = $fffe\n .byte <irq, >irq\n`;
    const o = openC64File('snap.vsf', snapshotOf(src, 0xc000, [0x35, 0x2f]));
    expect(o.entries).toEqual([0xc000, 0xc009]);
    const { A, ins } = run(o, { entries: o.entries });
    expect(A.mcfg!.port[0xc000]).toBe(bit(5));
    expect(ins(0xc000)).toMatch(/^lda \w+_e000$/); // RAM, not the KERNAL ROM
    expect(A.mcfg!.port[0xc009]).toBe(bit(5));
    expect(ins(0xc00b)).toBe('sta VIC_RASTER');
  });

  it('knows code under the KERNAL only runs with the KERNAL banked out', () => {
    const { A, ins } = run(fromSource('p.prg', '.pc = $e000\n jsr $ffd2\n rts'));
    expect(A.mcfg!.port[0xe000] & 0xcc).toBe(0);
    expect(ins(0xe000)).toBe('jsr $ffd2');
  });

  it('labels RAM under I/O when the code reads it with all RAM, and names the register otherwise', () => {
    const { ins, A } = run(fromSource('p.prg', `.pc = $c000
 lda #$34
 sta $01
 lda $d000
 ldx #$35
 stx $01
 lda $d000
 rts
.pc = $d000
 .byte 1, 2, 3, 4`));
    const ramRead = ins(0xc004)!;
    expect(ramRead).toMatch(/^lda [a-z]+_d000$/);
    expect(A.labels.has(0xd000)).toBe(true);
    expect(ins(0xc00b)).toBe('lda VIC_SPR0_X');
  });
});

describe('VIC bank', () => {
  it('follows the $dd02 trick and $dd00, and places $d018 in the selected bank', () => {
    const { A, cmt } = run(fromSource('p.prg', `.pc = $c000
 lda #$3d
 sta $dd02
 lda #$18
 sta $d018
 lda #$02
 sta $dd00
 rts`));
    expect(A.mcfg!.vic[0xc005]).toBe(bit(1));
    expect([...A.vic.banks]).toEqual([1]);
    expect(cmt(0xc002)).toContain('VIC bank 1 ($4000-$7fff)');
    expect(A.log.some(l => l.msg === 'VIC bank 1 ($4000-$7fff) selected via $dd02 at $c002, assuming $dd00 bits 0-1 are 0')).toBe(true);
    // a VIC register written with I/O banked out is RAM, not VIC evidence
    const ram = run(fromSource('p.prg', '.pc = $c000\n lda #$34\n sta $01\n lda #$02\n sta $dd00\n rts'));
    expect([...ram.A.vic.banks]).toEqual([0]);
  });

  it('counts $d018 in the bank a $dd00 store right after it selects', () => {
    const { A } = run(fromSource('p.prg', '.pc = $8000\n lda #$32\n sta $d018\n lda #$00\n sta $dd00\n rts\n.pc = $c800\n .fill 2048, $81\n'));
    expect([...A.vic.banks]).toEqual([3]);
    expect(A.blocks.find(b => b.type === 'charset')).toMatchObject({ start: 0xc800, reason: '$d018=$32 selects charset at $c800' });
  });

  it('goes on from a snapshot with the VIC bank its $dd00 holds, and never puts graphics over the zero page and the stack', () => {
    const src = '.pc = $8000\nloop: lda #$30\n sta $d018\n jmp loop\n.pc = $c000\n .fill 2048, $81\n';
    // $dd00 = $00 with $dd02 = $3f: bank 3, so the charset is at $c000
    const bank3 = openC64File('snap.vsf', snapshotOf(src, 0x8000, [0x37, 0x2f], [0x00, 0x3f]));
    const a = run(bank3, { entries: bank3.entries }).A;
    expect(a.mcfg!.vic[0x8000]).toBe(bit(3));
    expect(a.blocks.find(b => b.type === 'charset')).toMatchObject({ start: 0xc000, reason: '$d018=$30 selects charset at $c000' });
    // without CIA 2's state: bank 0, where $d018 = $30 would show the zero page and the stack
    const bank0 = openC64File('snap.vsf', snapshotOf(src, 0x8000));
    const b = run(bank0, { entries: bank0.entries }).A;
    expect(b.blocks.some(x => x.type === 'charset')).toBe(false);
    expect(b.log.some(l => l.msg === '$d018=$30 would put the charset at $0000, over the zero page and the stack, which the CPU changes all the time, so it is not taken as one')).toBe(true);
  });
});

describe('bank zones', () => {
  const prog = () => fromSource('p.prg', `.pc = $c000
 jsr sub
 rts
.pc = $c100
sub: sta $d020
 rts`);

  it('replace the detected configuration and flow on to the code they reach', () => {
    expect(run(prog()).ins(0xc100)).toBe('sta VIC_BORDER_COLOR');
    const { A, ins } = run(prog(), { bankZones: [{ start: 0xc000, end: 0xc003, port: 0x34 }] });
    expect(A.mcfg!.forcedPort[0xc000]).toBe(bit(4));
    expect(A.mcfg!.port[0xc100]).toBe(bit(4));
    expect(ins(0xc100)).toBe('sta $d020');
  });

  it('later zones win, and null returns a range to detection', () => {
    const { A } = run(prog(), { bankZones: [{ start: 0xc000, end: 0xc200, port: 0x34, vicBank: 2 }, { start: 0xc100, end: 0xc200, port: null }] });
    expect(A.mcfg!.forcedPort[0xc100]).toBe(0);
    expect(A.mcfg!.forcedVic[0xc100]).toBe(bit(2));
    expect(A.mcfg!.port[0xc100]).toBe(bit(4)); // still reaches it from the zone at $c000
  });

  it('are ignored when bank tracking is off', () => {
    const { A, ins } = run(fromSource('p.prg', '.pc = $c000\n lda #$35\n sta $01\n jsr $ffd2\n rts'), { settings: { bankTracking: false } });
    expect(A.mcfg).toBeNull();
    expect(ins(0xc004)).toBe('jsr CHROUT');
  });
});
