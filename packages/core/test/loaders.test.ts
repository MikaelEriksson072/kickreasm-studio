/* Loaders (analyze/loaders.ts): each known loader by its own code, taken from its source (Spindle 3.1 stage1.s, Spindle
 * 2.3's spin.exe, Krill's loader v194 hal-c64-c128.inc and install.s, Bitfire resident.asm, Sparkle sl.asm, Covert Bitops
 * loader v3 loader.s); other disk loaders by drive code, drive commands and a receive loop; tape and KERNAL loading; and
 * the marks in the source. The programs below are those loops (illegal opcodes as .byte), with a BASIC start that
 * reaches them where the loader is called. */
import { describe, expect, it } from 'vitest';
import { analyze, demoProject, makeShowcase, openC64File, parsePrg, render, verify, type LoaderFinding, type ProjectInput } from '../src';
import { fromSource, snapshotOf } from './helpers/programs';

const BASIC = '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n';
const project = (src: string): ProjectInput => ({ name: 'loader', files: [fromSource('loader.prg', BASIC + src)] });
const loaders = (src: string): LoaderFinding[] => analyze(project(src)).loaders;
const ids = (src: string) => loaders(src).map(l => `${l.id}${l.sure === 'likely' ? '?' : ''}`);

const SPINDLE3 = ` jsr $0200
 rts
.pc = $0200
 lda #$18
 .byte $80,$01
 cmp #$38
 beq done
 sta $dd00
check: bit $dd00
 bmi xfer
 bvc check
done: rts
xfer: eor #$28
 sta $dd00
 ldx #8
recvloop: ora $00
 lsr
 lsr
 eor $dd00
 .byte $8f,$00,$dd
 lsr
 lsr
 iny
 sty store+1
 ora $dd00
 stx $dd00
 lsr
 lsr
 sta last+1
 lda #$c0
 and $dd00
 sta $dd00
last: ora #0
store: sta $0300
 lda $dd00
 stx $dd00
 bcc recvloop
 rts
`;

const KRILL = ` jsr getloop
 rts
.pc = $0300
getloop: lsr
 lsr
 ldx #$37
 ora $dcc9,x
 stx $dd02
 ror
 ror
 ldx #$3f
 .byte $8f
 .word merge+1
 and $dd00
 stx $dd02
merge: ora #$00
 sta $1000,y
 .byte $a7,$fb
 adc $dd00
 stx $dd02
 iny
 beq out
 lsr
 lsr
 ldx #$3f
 ora $dd00
 stx $dd02
 jmp getloop
out: rts
.pc = $2000
 .byte $4d,$2d,$45,$0b,$02,$4b,$52,$49,$4c,$4c,$2e
`;

const BITFIRE = ` jsr gloop
 rts
.pc = $0300
gloop: lsr
 lsr
 ldx $02
 ora $dd00
 stx $dd02
 ror
 ror
 ldx #$3f
 .byte $8f
 .word nibble+1
 and $dd00
 stx $dd02
nibble: ora #$00
 sta $b00b,y
 adc $dd00
 stx $dd02
 lsr
 lsr
 dey
 cpy #$01
 ldx #$3f
 ora $dd00
 stx $dd02
 bcs gloop
 rts
`;

const SPARKLE = ` jsr rcv
 rts
.pc = $0160
rcv: lda $dd00
 sty $dd00
 lsr
 lsr
 dex
 nop
 ldy #$c0
 ora $dd00
 sty $dd00
 lsr
 lsr
 cpx #$af
 beq chg
 ldy #$08
 ora $dd00
 sty $dd00
 lsr
 lsr
 sta lastbits+1
 lda #$c0
 and $dd00
 sta $dd00
lastbits: ora #$00
 sta $0300,x
 bvc rcv
chg: rts
`;

const COVERT = ` jsr fill
 rts
.pc = $0400
fill: bit $dd00
 bpl fill
wait: lda $d011
 clc
 sbc $d012
 and #$07
 beq wait
 lda #$10
 ora $dd00
 sta $dd00
 and #$03
 sta eor+1
 sta $dd00
 lda $dd00
 lsr
 lsr
 eor $dd00
 lsr
 lsr
 eor $dd00
 lsr
 lsr
 eor $dd00
 cli
eor: eor #$00
 sta $0500,x
 rts
.pc = $2000
 .byte $20,$04,$04,$57,$2d,$4d
`;

/** a fast loader of no known kind: an installer, its drive code, the M-W/M-E commands and a 1-bit receive loop */
const OTHER = ` jsr install
 jsr receive
 rts
install: lda #8
 jsr $ffb1
 lda #$6f
 jsr $ff93
 ldx #0
send: lda mw,x
 jsr $ffa8
 inx
 cpx #6
 bne send
 jsr $ffae
 rts
receive: ldx #8
bit: lda $dd00
 asl
 ror $02
 lda $dd00
 lda $dd00
 lda $dd00
 dex
 bne bit
 rts
mw: .byte $4d,$2d,$57,$00,$05,$20
me: .byte $4d,$2d,$45,$00,$05
.pc = $3000
 sei
 lda $1800
 and #$04
 bne *-5
 lda #$08
 sta $1800
 lda $1c00
 ora #$04
 sta $1c00
 clv
 .byte $50,$fe
 lda $1c01
 sta $0300
 clv
 .byte $50,$fe
 lda $1c01
 sta $0301
 lda #$00
 sta $1800
 rts
`;

describe('loaders', () => {
  it('know Spindle 3 by its resident page and receive loop (eor $dd00 / sax $dd00)', () => {
    const [l] = loaders(SPINDLE3);
    expect(l).toMatchObject({ id: 'spindle', name: 'Spindle (lft)', sure: 'match' });
    expect(l.parts[0]).toMatchObject({ start: 0x0200, end: 0x0300, role: 'resident', what: 'resident page (jsr here to load the next part)' });
  });

  it('know Spindle 2 by its two resident pages at $0c00 and its table-driven loop', () => {
    const [l] = loaders(' jsr $0c90\n rts\n.pc = $0c90\n ldy $f6\n ldx $dd00\n sty $dd00\n eor $0c00,x\n ldy #8\n ldx $dd00\n sty $dd00\n eor $0c00,x\n rts\n');
    expect(l).toMatchObject({ id: 'spindle', parts: [{ start: 0x0c00, end: 0x0e00, role: 'resident' }] });
    expect(l.parts[0].what).toMatch(/^Spindle 2 receive loop/);
  });

  it("know Krill's loader by its receive loop, and its installer by its name next to M-E", () => {
    const [l] = loaders(KRILL);
    expect(l).toMatchObject({ id: 'krill', name: "Krill's loader (Krill/Plush)", sure: 'match' });
    expect(l.parts.map(p => p.role)).toEqual(['resident', 'command', 'text']);
    // the installer on its own: "M-E" $020b "KRILL."
    const inst = loaders(' rts\n.pc = $2000\n .byte $4d,$2d,$45,$0b,$02,$4b,$52,$49,$4c,$4c,$2e\n');
    expect(inst.map(x => [x.id, x.parts.map(p => p.role)])).toEqual([['krill', ['command', 'text']]]);
    // the name alone is any text
    expect(loaders(' rts\n.pc = $2000\n .byte $4b,$52,$49,$4c,$4c,$2e\n')).toEqual([]);
  });

  it('know Sparkle in the stack of a snapshot, which opens from $0200 without it', () => {
    // a later Sparkle: inx for dex, ora #$01 for ora #$00
    const later = SPARKLE.replace(' dex\n', ' inx\n').replace('lastbits: ora #$00', 'lastbits: ora #$01');
    expect(ids(later)).toEqual(['sparkle']);
    const vsf = snapshotOf(`.pc = $c000\n jsr $0160\n jmp $c000\n${later.replace(' jsr rcv\n rts\n', '')}`, 0xc000);
    const open = (zeroPage: boolean) => { const o = openC64File('s.vsf', vsf, { zeroPage }); return analyze({ name: 's', files: [o], entries: o.entries }).loaders; };
    const [out] = open(false);
    expect(out).toMatchObject({ id: 'sparkle', sure: 'match' });
    expect(out.parts).toEqual([{ start: 0x0160, end: 0x0193, role: 'resident', what: 'receive loop (lda $dd00 / sty $dd00), in the stack, which this snapshot is opened without', outside: true }]);
    // opened with the zero page and the stack, the loop is in the listing like any part
    const [inside] = open(true);
    expect(inside.parts.map(p => [p.start, p.role, !!p.outside])).toEqual([[0x0160, 'resident', false]]);
  });

  it('know Bitfire, Sparkle and the Covert Bitops loader by their loops', () => {
    expect(ids(BITFIRE)).toEqual(['bitfire']);
    expect(ids(SPARKLE)).toEqual(['sparkle']);
    const covert = loaders(COVERT);
    expect(covert.map(l => l.id)).toEqual(['covert']);
    expect(covert[0].parts.map(p => [p.role, p.what])).toEqual([
      ['resident', 'receive loop (waits for no badline, then lda $dd00 / lsr / lsr / eor $dd00 …)'],
      ['command', 'drive command M-W, stored backwards (its installer sends it from the end)'],
    ]);
    // the classic loop alone is many loaders'
    const classic = loaders(' jsr r\n rts\nr: lda $dd00\n lsr\n lsr\n eor $dd00\n lsr\n lsr\n eor $dd00\n lsr\n lsr\n eor $dd00\n rts\n');
    expect(classic.map(l => `${l.id}${l.sure}`)).toEqual(['fastloaderlikely']);
    expect(classic[0].parts[0].what).toMatch(/^receive loop: the classic 2-bit loop .* as in the Covert Bitops loader and many older loaders$/);
  });

  it('find any other fast loader by its drive code, drive commands, installer and receive loop', () => {
    const [l] = loaders(OTHER);
    expect(l).toMatchObject({ id: 'fastloader', name: 'A fast loader (not one of the known ones)', sure: 'likely' });
    const by = (role: string) => l.parts.filter(p => p.role === role);
    expect(by('drivecode')).toEqual([expect.objectContaining({ start: 0x3000 })]);
    expect(by('command').map(p => p.what)).toEqual(['drive command M-W $0500, 32 bytes into the drive', 'drive command M-E $0500: starts the code there in the drive']);
    expect(by('install')[0].what).toBe('talks to the drive through the KERNAL (LISTEN, SECOND, CIOUT, UNLSN): sends the drive code and its commands');
    expect(by('resident')[0].what).toBe('receive loop: reads the serial bus at $dd00 4 times (1-bit)');
  });

  it('know a tape turbo loader and the KERNAL LOAD', () => {
    expect(ids(' jsr t\n rts\nt: lda #$90\n sta $dc0d\nw: lda $dc0d\n and #$10\n beq w\n lda $dc04\n ldx #$19\n stx $dc0e\n rts\n')).toEqual(['tape?']);
    expect(loaders(' lda #1\n ldx #8\n ldy #1\n jsr $ffba\n lda #0\n jsr $ffd5\n rts\n')).toEqual([expect.objectContaining({ id: 'kernal', name: 'KERNAL LOAD', parts: [expect.objectContaining({ role: 'kernal' })] })]);
  });

  it('find nothing in programs without a loader (a VIC bank switch reads $dd00 once)', () => {
    expect(analyze(demoProject()).loaders).toEqual([]);
    const s = makeShowcase();
    expect(analyze({ name: 's', files: [parsePrg(s.name, s.prg)] }).loaders).toEqual([]);
    expect(loaders(' lda $dd00\n and #$fc\n ora #$02\n sta $dd00\n rts\n')).toEqual([]);
  });

  it('mark the parts in the source, above the line where each starts and ends, and still build byte-exact', () => {
    const p = project(OTHER);
    const A = analyze(p), R = render(A, p);
    expect(verify(A, R).ok).toBe(true);
    const text = R.files['loader.asm'] as string;
    expect(text).toContain('// loader found by Mimir Studio (the ==== lines mark their parts):\n//   A fast loader (not one of the known ones) (by its traits): reads the serial bus at $dd00 4 times (1-bit)\n');
    expect(text).toMatch(/\/\/ ==== A fast loader \(not one of the known ones\): drive command M-W \$0500, 32 bytes into the drive ====\n(\w+:\n)? +\.byte \$4d, \$2d, \$57/);
    expect(text).toContain('// ==== A fast loader (not one of the known ones): code for the 1541:');
    expect(text).toContain('// ==== end of A fast loader (not one of the known ones): its installer ====');
    // the marks are listing lines of their own
    expect(R.lines.filter(l => l.k === 'cmt' && l.mark).length).toBeGreaterThanOrEqual(6);
  });
});

/** fixtures/prg/loader-demo.prg (the e2e tests open it): an installer that sends drive code with M-W and starts it with
 *  M-E, the drive code, and a Spindle 3 resident page at $0c00 that the program calls */
export const LOADER_DEMO = OTHER.replace(' jsr receive\n', ' jsr $0c00\n') + SPINDLE3.replace(' jsr $0200\n rts\n.pc = $0200\n', '.pc = $0c00\n').replace('store: sta $0300', 'store: sta $0d00');

describe('the loader fixture', () => {
  it('is fixtures/prg/loader-demo.prg, which the e2e tests open', async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { makePrg } = await import('../src');
    const f = fromSource('loader-demo.prg', BASIC + LOADER_DEMO), prg = makePrg(f.load, f.bytes);
    const path = join(__dirname, '../../../fixtures/prg/loader-demo.prg');
    if (process.env.WRITE_FIXTURES) writeFileSync(path, prg);
    expect(new Uint8Array(readFileSync(path))).toEqual(prg);
    const A = analyze({ name: 'loader-demo', files: [f] });
    expect(A.loaders.map(l => [l.id, l.parts.map(p => p.role)])).toEqual([['spindle', ['install', 'command', 'command', 'resident', 'drivecode']]]);
  });
});
