/* Raster interrupts (5.16, analyze/raster.ts): every IRQ handler with the line it runs at, from the $d012 and $d011
 * writes where its vector is set: a chain of three, a handler that sets its own next line, a line from a table, and a
 * snapshot whose handler was installed by code nothing traced reaches. */
import { describe, expect, it } from 'vitest';
import { analyze, makeDemo, openC64File, parsePrg, type RasterIrq } from '../src';
import { fromSource, snapshotOf } from './helpers/programs';

const BASIC = '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n';
const rows = (src: string) => analyze({ name: 'r', files: [fromSource('r.prg', src)] }).raster;
const brief = (r: RasterIrq) => [r.line, r.d012, r.d011 && (r.d011.value ?? r.d011.bit8), r.handler, r.from];

describe('raster interrupts', () => {
  it('lists a chain of handlers with the line each runs at, $d011 bit 7 as bit 8', () => {
    // main: irq1 at line $30 ($d011 bit 7 cleared by `and #$7f`); irq1: irq2 at $f8; irq2: irq1 at $30 + 256
    const src = `${BASIC} sei
 lda #$35
 sta $01
 lda #<irq1
 sta $fffe
 lda #>irq1
 sta $ffff
 lda #$30
 sta $d012
 lda $d011
 and #$7f
 sta $d011
 lda #1
 sta $d01a
 cli
loop: jmp loop
irq1: pha
 lda #<irq2
 sta $fffe
 lda #>irq2
 sta $ffff
 lda #$f8
 sta $d012
 asl $d019
 pla
 rti
irq2: pha
 lda #<irq1
 sta $fffe
 lda #>irq1
 sta $ffff
 lda #$30
 sta $d012
 lda #$9b
 sta $d011
 asl $d019
 pla
 rti
`;
    const r = rows(src);
    const irq1 = r.find(x => x.from === null)!.handler, irq2 = r.find(x => x.from === irq1)!.handler;
    expect(r.map(brief)).toEqual([
      [0x30, 0x30, 0, irq1, null],
      [0xf8, 0xf8, null, irq2, irq1],
      [0x130, 0x30, 0x9b, irq1, irq2],
    ]);
    expect(r[0]).toMatchObject({ vector: 0xfffe, d011: { value: null, bit8: 0 } });
    expect(r[1].d011).toBeNull();
  });

  it('lists a handler that sets its own next line, and one whose line comes from a table', () => {
    const self = rows(`${BASIC} sei\n lda #<irq\n sta $0314\n lda #>irq\n sta $0315\n lda #$40\n sta $d012\n cli\n rts\nirq: lda #$80\n sta $d012\n asl $d019\n jmp $ea31\n`);
    const irq = self[0].handler;
    expect(self.map(brief)).toEqual([[0x40, 0x40, null, irq, null], [0x80, 0x80, null, irq, irq]]);
    expect(self[1]).toMatchObject({ vector: null, installedAt: null });
    const table = rows(`${BASIC} sei\n lda #<irq\n sta $0314\n lda #>irq\n sta $0315\n cli\n rts\nirq: ldx $02\n lda lines,x\n sta $d012\n asl $d019\n jmp $ea31\nlines: .byte $20, $60, $a0\n`);
    // the main code sets the vector but not $d012; the handler writes $d012 from the table
    expect(table.map(r => [r.line, r.d012, r.setAt != null, r.from === null])).toEqual([[null, null, false, true], [null, null, true, false]]);
  });

  it('finds the demo\'s IRQ at line 98 and a snapshot\'s live handler', () => {
    const d = makeDemo();
    expect(analyze({ name: 'demo', files: [parsePrg(d.name, d.prg)] }).raster.map(brief)).toEqual([[98, 0x62, 0x1b, 0x08b7, null]]);
    // the handler $fffe points at writes its next line; nothing traced installs it
    const src = `.pc = $c000\nloop: jmp loop\nirq: lda #$e0\n sta $d012\n asl $d019\n rti\n.pc = $fffe\n .byte <irq, >irq\n`;
    const o = openC64File('snap.vsf', snapshotOf(src, 0xc000, [0x35, 0x2f]));
    const A = analyze({ name: 'snap', files: [o], entries: o.entries });
    expect(A.raster.map(brief)).toEqual([[0xe0, 0xe0, null, 0xc003, 0xc003]]);
  });
});
