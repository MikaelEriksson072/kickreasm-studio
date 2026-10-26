/* Music detection (spec 5.8, analyze/music.ts): a player's jump table, found when the program calls init and play, when
 * a snapshot was taken after init ran (only play traced, from the IRQ), when nothing traced reaches it, with play after
 * two or four JMPs or right after JMP init, and never in the program's own start-up table, code that calls the player
 * or a JMP pair in code that clears the SID. The player below plays three voices from a PAL note frequency table. */
import { describe, expect, it } from 'vitest';
import { analyze, findBlock, openC64File, render, verify, type MusicInfo, type ProjectInput } from '../src';
import { noteTables } from '../src/analyze/music';
import { fromSource, snapshotOf } from './helpers/programs';

const BASIC = '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n';
const hex = (v: number[]) => v.map(x => `$${x.toString(16).padStart(2, '0')}`).join(',');
/** C-0 to B-7 for a PAL C64 (985248 Hz) */
const FREQ = Array.from({ length: 96 }, (_, n) => Math.min(0xffff, Math.round(16.3516 * 2 ** (n / 12) * 16777216 / 985248)));

/** `table` is the player's jump table; `entries` adds code at the labels it jumps to */
const player = (table = ' jmp init\n jmp play\n', entries = '') => `.pc = $1000
${table}init: sta song
 lda #$0f
 sta $d418
 rts
${entries}play: ldx #0
voice: ldy notes,x
 lda freqlo,y
 sta $d400,x
 lda freqhi,y
 sta $d401,x
 lda #$41
 sta $d404,x
 lda #$09
 sta $d405,x
 txa
 clc
 adc #7
 tax
 cpx #21
 bne voice
 rts
song: .byte 0
notes: .byte 12,0,0,0,0,0,0,24,0,0,0,0,0,0,36
freqlo: .byte ${hex(FREQ.map(f => f & 0xff))}
freqhi: .byte ${hex(FREQ.map(f => f >> 8))}
`;
/** a main program at $080d: `main` runs first, then the IRQ (calling `irq`) is installed and it loops */
const program = (main: string, irq: string) => `${BASIC}${main} sei
 lda #<irqh
 sta $0314
 lda #>irqh
 sta $0315
 cli
loop: jmp loop
irqh: ${irq}
 jmp $ea31
`;
const project = (src: string): ProjectInput => ({ name: 'music', files: [fromSource('music.prg', src)] });
const music = (p: ProjectInput) => analyze(p).music.map((m: MusicInfo) => [m.start, m.init, m.play]);

describe('music detection', () => {
  it('finds a player whose init and play the program calls, with its note table and the data after the code', () => {
    const p = project(program(' lda #0\n jsr $1000\n', 'jsr $1003') + player());
    const A = analyze(p);
    expect(A.music.map(m => [m.start, m.init, m.play])).toEqual([[0x1000, 0x1000, 0x1003]]);
    expect(A.music[0].why).toEqual(expect.arrayContaining(['JMP init / JMP play table', 'init and play both called from outside', 'play called from the IRQ']));
    expect(A.music[0].why.some(w => /^note frequency table at \$10/.test(w))).toBe(true);
    // the block holds the tables after the code
    expect(A.music[0].end).toBe(p.files[0].load + p.files[0].bytes.length);
    expect(findBlock(A.blocks, 0x1000)?.type).toBe('music');
  });

  it('finds the player in a VICE snapshot taken after init ran: only play is traced, from the IRQ', () => {
    // the program called init and installed its IRQ before the snapshot; the CPU is in the main loop at $0900
    const src = `.pc = $0900\nloop: jmp loop\nirqh: jsr $1003\n jmp $ea31\n.pc = $0314\n.byte <irqh, >irqh\n` + player();
    const o = openC64File('tune.vsf', snapshotOf(src, 0x0900));
    expect(o.entries).toEqual([0x0900, 0x0903]);
    const p: ProjectInput = { name: 'tune', files: [o], entries: o.entries };
    const A = analyze(p);
    expect(A.music.map(m => [m.start, m.init, m.play])).toEqual([[0x1000, 0x1000, 0x1003]]);
    expect(A.music[0].why).toEqual(expect.arrayContaining(['play called from the IRQ']));
    expect(A.music[0].why.some(w => /instructions decoded from the table \(the trace did not reach them\)/.test(w))).toBe(true);
    // the source loads it as a .sid and the IRQ calls music.play; it still assembles to the same bytes
    const R = render(A, p);
    const asm = Object.entries(R.files).find(([n]) => n.endsWith('.asm') && !n.startsWith('include/'))![1] as string;
    expect(asm).toContain('.var music = LoadSid("music/music_1000.sid")');
    expect(asm).toContain('jsr music.play');
    expect(verify(A, R).ok).toBe(true);
  });

  it('decodes a player nothing traced reaches when its table starts a page and its code reads a note table', () => {
    expect(music(project(`${BASIC} rts\n` + player()))).toEqual([[0x1000, 0x1000, 0x1003]]);
    // the same JMP pair off a page boundary with nothing calling it is not taken for a player
    expect(music(project(`${BASIC} rts\n` + player().replace('.pc = $1000', '.pc = $1040')))).toEqual([]);
  });

  it('takes play from the entry the IRQ calls: the play code after two JMPs (+6) or four (+12)', () => {
    const two = player(' jmp init\n jmp sfx\n', 'sfx: sta $d40b\n rts\n').replace('play: ldx #0', 'play: ldx #0');
    expect(music(project(program(' lda #0\n jsr $1000\n', 'jsr $1006') + two.replace(' jmp sfx\n', ' jmp sfx\nplaycode:\n').replace('init: sta song', 'jmp play\ninit: sta song')))).toEqual([[0x1000, 0x1000, 0x1006]]);
    const four = ' jmp init\n jmp sfx\n jmp sfx\n jmp sfx\n jmp play\n';
    expect(music(project(program(' lda #0\n jsr $1000\n', 'jsr $100c') + player(four, 'sfx: sta $d40b\n rts\n')))).toEqual([[0x1000, 0x1000, 0x100c]]);
  });

  it('takes the play code right after JMP init when the program calls both', () => {
    const src = program(' lda #0\n jsr $1000\n', 'jsr $1003') + player(' jmp init\n').replace('init: sta song\n lda #$0f\n sta $d418\n rts\n', '').replace('song: .byte 0', 'init: sta song\n lda #$0f\n sta $d418\n rts\nsong: .byte 0');
    expect(music(project(src))).toEqual([[0x1000, 0x1000, 0x1003]]);
  });

  it('takes play from the entry the IRQ calls, not one the program calls (a volume entry)', () => {
    const table = ' jmp init\n jmp volume\n jmp play\n';
    const src = program(' lda #0\n jsr $1000\n lda #8\n jsr $1003\n', 'jsr $1006') + player(table, 'volume: sta $d418\n rts\n');
    expect(music(project(src))).toEqual([[0x1000, 0x1000, 0x1006]]);
  });

  it('is not fooled by the program\'s own start-up table or by a routine that calls init and play', () => {
    // BASIC starts the JMP table at $080d; the IRQ calls a routine at $0c00 that follows a JMP and calls play
    const src = `${BASIC} jmp start\n jmp $1000\n jmp $1003\nstart: lda #0\n jsr $1000\n sei\n lda #<irqh\n sta $0314\n lda #>irqh\n sta $0315\n cli\nloop: jmp loop\nirqh: jsr frame\n jmp $ea31\n`
      + `.pc = $0c00\n jmp start\nframe: inc $d020\n jsr $1003\n dec $d020\n rts\n` + player();
    expect(music(project(src))).toEqual([[0x1000, 0x1000, 0x1003]]);
  });

  it('does not take a JMP pair in code that clears the SID for a player', () => {
    const src = `${BASIC} ldx #$18\n lda #0\nclear: sta $d400,x\n dex\n bpl clear\n lda #$0f\n sta $d418\n jmp next\n jmp clear\nnext: sta $d404\n sta $d40b\n rts\n`;
    expect(music(project(src))).toEqual([]);
  });
});

describe('note frequency tables', () => {
  const at = (bytes: number[], a = 0x2000) => { const mem = new Uint8Array(0x10000); mem.set(bytes, a); return noteTables(mem, x => x >= 0x1000 && x < 0x4000); };
  it('finds the high bytes of a table, apart from the low bytes or in pairs with them', () => {
    expect(at([...FREQ.map(f => f & 0xff), ...FREQ.map(f => f >> 8)]).map(t => t.start)).toContain(0x2060);
    expect(at(FREQ.flatMap(f => [f & 0xff, f >> 8])).map(t => t.start)).toContain(0x2001);
  });
  it('ignores a ramp, a fill and a sine', () => {
    expect(at(Array.from({ length: 256 }, (_, i) => i))).toEqual([]);
    expect(at(Array(256).fill(0x20))).toEqual([]);
    expect(at(Array.from({ length: 256 }, (_, i) => Math.round(127 + 127 * Math.sin(i / 256 * 2 * Math.PI))))).toEqual([]);
  });
});
