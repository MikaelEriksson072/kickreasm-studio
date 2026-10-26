/* Heuristic unit tests: one small synthetic program per rule (spec 16). */
import { describe, expect, it } from 'vitest';
import { analyze, findBlock, h4, hwSymbol, parseBasic, render, verify, type FileInput } from '../src';
import { fromSource } from './helpers/programs';

const run = (file: FileInput, extra: object = {}) => {
  const p = { name: 't', files: [file], ...extra };
  const A = analyze(p);
  const R = render(A, p);
  return { A, R, V: verify(A, R), src: R.files[`${R.fileNames[0]}.asm`] as string };
};
const label = (A: ReturnType<typeof analyze>, a: number) => A.labels.get(a)?.name;
const addrOf = (A: ReturnType<typeof analyze>, prefix: string) => [...A.labels].find(([, l]) => l.name.startsWith(prefix))?.[0] ?? -1;

describe('entry points', () => {
  it('reads SYS from a BASIC stub and labels it start', () => {
    const { A, src, V } = run(fromSource('b.prg', '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n rts'));
    expect(A.entry).toBe(0x080d);
    expect(A.basics[0]).toMatchObject({ sys: 2061, upstart: true });
    expect(label(A, 0x080d)).toBe('start');
    expect(src).toContain('BasicUpstart2(start)');
    expect(V.ok).toBe(true);
  });

  it('parses BASIC lines with tokens', () => {
    const mem = new Uint8Array(0x10000), owner = new Int16Array(0x10000).fill(-1);
    const prog = [0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00];
    mem.set(prog, 0x0801); owner.fill(0, 0x0801, 0x0801 + prog.length);
    expect(parseBasic(mem, owner, 0x0801)?.lines[0].text).toBe('10 SYS2061');
  });

  it('uses the program start the user set, keeping the BASIC SYS target as code', () => {
    const file = fromSource('b.prg', '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n rts\n.pc = $0820\n inc $d020\n rts');
    expect(run(file).A.entry).toBe(0x080d);
    const { A, src, V } = run(file, { entryPoint: 0x0820 });
    expect(V.ok).toBe(true);
    expect(A.entry).toBe(0x0820);
    expect(label(A, 0x0820)).toBe('start');
    expect(findBlock(A.blocks, 0x0820)?.type).toBe('code');
    // the stub still SYSes $080d: that stays code, under its own name
    expect(label(A, 0x080d)).toBe('entry_080d');
    expect(src).toContain('BasicUpstart2(entry_080d)');
    expect(src).toMatch(/· entry start · Kick Assembler/);
    expect(A.log.some(l => l.msg === 'Program start set by you: $0820')).toBe(true);
  });

  it('does not trace the load address when the user set the start', () => {
    const file = fromSource('c.prg', '.pc = $c000\n.byte $a9,$00,$8d,$20\n.pc = $c010\n lda #$01\n sta $d021\n rts');
    expect(findBlock(run(file).A.blocks, 0xc000)?.type).toBe('code');
    const { A, V } = run(file, { entryPoint: 0xc010 });
    expect(V.ok).toBe(true);
    expect(findBlock(A.blocks, 0xc000)?.type).not.toBe('code');
    expect(label(A, 0xc010)).toBe('start');
    expect(A.log.some(l => /No BASIC stub/.test(l.msg))).toBe(false);
  });

  it('falls back to the detected start when the one the user set is not loaded', () => {
    const { A } = run(fromSource('c.prg', '.pc = $c000\n rts'), { entryPoint: 0x2000 });
    expect(A.entry).toBe(0xc000);
    expect(A.log.some(l => l.lvl === 'warn' && /\$2000\) is not in a loaded file/.test(l.msg))).toBe(true);
  });

  it('uses the load address without a stub', () => {
    const { A } = run(fromSource('c.prg', '.pc = $c000\n inc $d020\n rts'));
    expect(A.entry).toBe(0xc000);
    expect(A.log.some(l => /No BASIC stub/.test(l.msg))).toBe(true);
  });
});

describe('tracing idioms', () => {
  it('follows IRQ vector setup and names the handler', () => {
    const { A, src } = run(fromSource('irq.prg', `.pc = $c000
 sei
 lda #<handler
 sta $0314
 lda #>handler
 sta $0315
 cli
 rts
handler:
 inc $d019
 jmp $ea31`));
    // sei, lda #, sta, lda #, sta, cli, rts = 13 bytes before the handler
    expect(label(A, 0xc00d)).toBe('irq_c00d');
    expect(src).toContain('lda #<irq_c00d');
    expect(src).toContain('jmp IRQ_HANDLER');
  });

  it('detects the BIT-skip idiom', () => {
    const { A, src, V } = run(fromSource('bit.prg', `.pc = $c000
 jsr a
 jsr b
 rts
a: lda #$02
 .byte $2c
b: lda #$06
 sta $d020
 rts`));
    expect(A.skip.size).toBe(1);
    expect(src).toMatch(/\.byte \$2c +\/\/ bit abs: skips the next 2-byte instruction/);
    expect(V.ok).toBe(true);
  });

  it('labels self-modified instructions and references them as label+1', () => {
    // (a jump target keeps its l_/loop_ name: branch labels are assigned before smc_ labels)
    const { A, src } = run(fromSource('smc.prg', `.pc = $c000
 ldx #$00
m: lda #$05
 sta $d020
 inc m+1
 rts`));
    expect(label(A, 0xc002)).toBe('smc_c002');
    expect(src).toContain('inc smc_c002+1');
  });

  it('resolves lo/hi jump tables used through JMP (zp)', () => {
    const { A, src } = run(fromSource('jt.prg', `.pc = $c000
 ldx #$01
 lda lo,x
 sta $fb
 lda hi,x
 sta $fc
 jmp ($00fb)
fa: rts
fb: inc $d020
 rts
lo: .byte <fa,<fb
hi: .byte >fa,>fb`));
    expect(label(A, 0xc00f)).toBe('fx_c00f');
    expect(label(A, 0xc010)).toBe('fx_c010');
    expect(findBlock(A.blocks, 0xc014)?.type).toBe('lohi');
    expect(src).toContain('.byte <fx_c00f, <fx_c010');
    expect(src).toContain('.byte >fx_c00f, >fx_c010');
  });

  it('stops after a JSR to a routine that pops its return address (inline data)', () => {
    const { A } = run(fromSource('inl.prg', `.pc = $c000
 jsr print
 .byte $41,$42,$00
 rts
print: pla
 sta $fb
 pla
 sta $fc
 rts`));
    expect(A.inlineCalls.has(0xc000)).toBe(true);
    expect(A.insLen[0xc003]).toBe(0);
  });

  it('reports JAM opcodes reached by code', () => {
    const { A } = run(fromSource('jam.prg', '.pc = $c000\n nop\n .byte $02'));
    expect(A.log.some(l => l.lvl === 'err' && /JAM/.test(l.msg))).toBe(true);
  });
});

describe('data classification', () => {
  it('finds PETSCII text printed through CHROUT', () => {
    const { A, src } = run(fromSource('txt.prg', `.pc = $c000
 ldx #$00
l: lda msg,x
 beq d
 jsr $ffd2
 inx
 bne l
d: rts
.encoding "petscii_upper"
msg: .text "HELLO"
 .byte 0`));
    const b = findBlock(A.blocks, addrOf(A, 'txt_'))!;
    expect(b.start).toBe(0xc00e);
    expect(b.type).toBe('text');
    expect(b.props.enc).toBe('petscii');
    expect(src).toContain('.text "HELLO"');
  });

  it('writes text in the encoding chosen: mixed case, and @ inside screen code text', () => {
    const hex = (bs: number[]) => bs.map(b => '$' + b.toString(16).padStart(2, '0')).join(',');
    const scr = [0x48, 0x05, 0x0c, 0x0c, 0x0f, 0x20, 0x00, 0x19, 0x0f, 0x15, 0x00]; // "Hello @you" + $00, lower case set
    const pet = [0xc8, 0x49, 0x20, 0x54, 0x48, 0x45, 0x52, 0x45, 0x0d]; // "Hi there" + RETURN, lower case set
    const up = [0x08, 0x09, 0x00, 0x01, 0x80, 0x00]; // "HI@A", an inverse @, $00
    const file = fromSource('t.prg', `.pc = $c000\n rts\n.pc = $c010\n.byte ${hex(scr)}\n.pc = $c030\n.byte ${hex(pet)}\n.pc = $c050\n.byte ${hex(up)}`);
    const { src, V } = run(file, { overrides: [
      { start: 0xc010, end: 0xc010 + scr.length, type: 'text', props: { enc: 'screen-mixed' } },
      { start: 0xc030, end: 0xc030 + pet.length, type: 'text', props: { enc: 'petscii-mixed' } },
      { start: 0xc050, end: 0xc050 + up.length, type: 'text', props: { enc: 'screen' } },
    ] });
    expect(V.ok).toBe(true);
    expect(src).toMatch(/\.encoding "screencode_mixed"\n\s+\.text "Hello @you"\n\s+\.byte \$00 +\/\/ end\n/);
    expect(src).toMatch(/\.encoding "petscii_mixed"\n\s+\.text "Hi there"\n\s+\.byte \$0d +\/\/ RETURN\n/);
    expect(src).toMatch(/\.encoding "screencode_upper"\n\s+\.text "HI@A"\n\s+\.byte \$80, \$00\n/);
    expect(src).toContain('// ---- Text (screen codes, mixed case)');
  });

  it('finds color tables stored to VIC color registers', () => {
    const { A } = run(fromSource('col.prg', `.pc = $c000
 ldx #$00
l: lda cols,x
 sta $d020
 inx
 cpx #$08
 bne l
 rts
cols: .byte 0,1,2,3,4,5,6,7`));
    const b = findBlock(A.blocks, 0xc00e)!;
    expect(b).toMatchObject({ type: 'table', props: { sub: 'colors' } });
    expect(label(A, 0xc00e)).toBe('colors_c00e');
  });

  it('turns $d018 and sprite pointer writes into graphics blocks', () => {
    const lines = ['.pc = $1000', ' lda #$1c', ' sta $d018', ' lda #$80', ' sta $07f8', ' rts', '.pc = $2000', ...Array.from({ length: 8 }, (_, i) => ` .byte ${Array.from({ length: 8 }, (_, j) => (i * 8 + j) & 0x18 ? '$ff' : '$00').join(',')}`), '.pc = $3000', ...Array.from({ length: 256 }, (_, i) => ` .byte $3c,$66,$6e,$6e,$60,$62,$3c,$${(i & 0xff).toString(16).padStart(2, '0')}`)];
    const { A } = run(fromSource('gfx.prg', lines.join('\n')));
    expect(findBlock(A.blocks, 0x2000)?.type).toBe('sprite');
    expect(findBlock(A.blocks, 0x3000)?.type).toBe('charset');
    expect(A.vic.sprites[0]).toMatchObject({ n: 0, ptr: 0x80, addr: 0x2000 });
  });

  it('keeps a byte between routines in the charset or screen $d018 selects as data, and a window that is mostly code no graphics', () => {
    // $d018 = $18 selects the charset at $2000 and $d018 = $84 the screen there, where the program has code with a
    // 1-byte variable between two routines
    for (const [v, what] of [['$18', 'Charset'], ['$84', 'Screen matrix']]) {
      const src = `.pc = $1000\n lda #${v}\n sta $d018\n jsr $2000\n rts\n.pc = $2000\n inc count\n jsr more\n rts\ncount: .byte 0\nmore: lda count\n sta $d020\n rts\n`;
      const { A, V } = run(fromSource('var.prg', src));
      expect(findBlock(A.blocks, 0x2007)?.type, what).toBe('data');
      expect(A.blocks.some(b => b.type === 'charset' || b.type === 'screen'), what).toBe(false);
      expect(A.log.some(l => l.msg.startsWith(`${what} at $2000`)), what).toBe(false);
      expect(V.ok).toBe(true);
    }
  });

  it('splits a charset around code into pieces of at least one character, each with the reason', () => {
    // 2 KB of glyphs at $3000 with two 1-byte routines at $3400 and $3406 that the program calls: the glyphs stay a
    // charset on both sides, and the 5 bytes between the routines stay data
    const glyphs = Array.from({ length: 256 }, (_, i) => ` .byte $3c,$66,$6e,$6e,$60,$62,$3c,$${i.toString(16).padStart(2, '0')}`);
    const lines = ['.pc = $1000', ' lda #$1c', ' sta $d018', ' jsr $3400', ' jsr $3406', ' rts', '.pc = $3000', ...glyphs.slice(0, 128), ' rts', ' .byte 1,2,3,4,5', ' rts', ...glyphs.slice(129)];
    const { A, V } = run(fromSource('split.prg', lines.join('\n')));
    expect(findBlock(A.blocks, 0x3000)).toMatchObject({ type: 'charset', start: 0x3000, end: 0x3400, reason: '$d018=$1c selects charset at $3000' });
    expect(findBlock(A.blocks, 0x3400)?.type).toBe('code');
    expect(findBlock(A.blocks, 0x3401)).toMatchObject({ type: 'data', start: 0x3401, end: 0x3406 });
    expect(findBlock(A.blocks, 0x3406)?.type).toBe('code');
    expect(findBlock(A.blocks, 0x3407)).toMatchObject({ type: 'charset', start: 0x3407, reason: '$d018=$1c selects charset at $3000' });
    expect(V.ok).toBe(true);
  });
});

describe('code islands', () => {
  const BASIC = '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n';
  // the start routine that ran once installs an IRQ: nothing traced calls it (a snapshot taken later, say)
  const SETUP = `${BASIC} lda #0\n sta $d020\n rts\nsetup: sei\n lda #<irq\n sta $0314\n lda #>irq\n sta $0315\n lda #1\n sta $d01a\n cli\n rts\nirq: inc $d020\n asl $d019\n jmp $ea31\n`;
  const at = (src: string, extra: object = {}) => run(fromSource('i.prg', src), extra);

  it('decodes data nothing traced reaches as code when it reads as a routine, and traces on from it', () => {
    const { A, V, src } = at(SETUP);
    const setup = 0x0813;
    expect(findBlock(A.blocks, setup)).toMatchObject({ type: 'code', start: setup, reason: 'nothing traced reaches it, but it decodes as a routine' });
    expect(A.entryKind.get(setup)).toBe('guess');
    expect(label(A, setup)).toBe('code_0813');
    // the handler it installs is found through the vector it writes
    expect(A.entryKind.get(0x0825)).toBe('irq');
    expect(A.log.some(l => l.msg === 'Unreached code at $0813: 9 instructions ending in RTS, so it is decoded as code. Mark it as data (D) if it is not.')).toBe(true);
    expect(src).toMatch(/code_0813:\s+sei/);
    expect(V.ok).toBe(true);
  });

  it('leaves it as data with the hint when the setting is off or the user marked it as data', () => {
    const off = at(SETUP, { settings: { codeIslands: false } });
    expect(findBlock(off.A.blocks, 0x0813)).toMatchObject({ type: 'data', hint: 'code' });
    const marked = at(SETUP, { overrides: [{ start: 0x0813, end: 0x0825, type: 'data' }] });
    expect(findBlock(marked.A.blocks, 0x0813)).toMatchObject({ type: 'data', user: true });
    expect(marked.A.entryKind.get(0x0813)).toBeUndefined();
  });

  it('starts after fill and skips data with BRK, a branch out of it, RTI without an acknowledge, or 1541 code', () => {
    const filled = at(`${BASIC} rts\n .fill 6, 0\n lda #1\n sta $d020\n lda #2\n sta $d021\n ldx #0\n stx $d015\n rts\n`);
    expect(findBlock(filled.A.blocks, 0x0814)).toMatchObject({ type: 'code', start: 0x0814 });
    expect(findBlock(filled.A.blocks, 0x080e)?.type).toBe('fill');
    const data = [
      '.byte $a9,$00,$8d,$20,$d0,$00,$a9,$01,$8d,$21,$d0,$60', // lda #0 / sta $d020 / brk
      '.byte $aa,$aa,$a8,$45,$50,$aa,$a8,$a8,$aa,$aa,$aa,$40', // tax / … / rti: a table ending in $40
      '.byte $aa,$a8,$50,$80,$aa,$aa,$aa,$a8,$a8,$aa,$aa,$60', // bvc out of the block
      'lda $1c00\n ora #$08\n sta $1c00\n lda $1800\n and #$fb\n sta $1800\n rts', // the drive's VIA: a loader's 1541 code
    ];
    for (const d of data) {
      const { A, V } = at(`${BASIC} rts\n ${d}\n`);
      expect(findBlock(A.blocks, 0x080e)?.type, d).not.toBe('code');
      expect(V.ok).toBe(true);
    }
  });
});

describe('data as code (listing preview)', () => {
  // code nothing jumps to, so it is classified as data
  const file = () => fromSource('h.prg', '.pc = $c000\n rts\nhidden: .byte $a9,$01,$8d,$20,$d0,$60\n.pc = $c010\nmsg: .text "HELLO"');
  const p = { name: 't', files: [file()], notes: { 0xc003: { text: 'store' } } };

  it('shows the bytes of data blocks as instructions, with the notes in place', () => {
    const A = analyze(p);
    expect(findBlock(A.blocks, 0xc001)?.type).not.toBe('code');
    const R = render(A, p, { dataAsCode: true });
    const ins = R.lines.filter(l => l.k === 'ins' && l.preview).map(l => l.k === 'ins' && `${l.mn} ${l.tok.map(t => t.s).join('')}`.trim());
    expect(ins.slice(0, 3)).toEqual(['LDA #$01', 'STA VIC_BORDER_COLOR', 'RTS']);
    const i = R.lines.findIndex(l => l.k === 'ins' && l.preview && l.a === 0xc003);
    expect(R.lines[i - 1]).toMatchObject({ k: 'cmt', note: true, text: 'store' });
    expect(R.lines.some(l => l.k === 'hdr' && l.preview && l.a === 0xc001)).toBe(true);
    // the real code block is not touched
    expect(R.lines.some(l => l.k === 'ins' && !l.preview && l.a === 0xc000 && l.mn === 'RTS')).toBe(true);
  });

  it('changes nothing in the files, the file lines or the verification', () => {
    const A = analyze(p);
    const plain = render(A, p), preview = render(A, p, { dataAsCode: true });
    expect(preview.files).toEqual(plain.files);
    expect(preview.fileLines).toEqual(plain.fileLines);
    expect(verify(A, preview).ok).toBe(true);
    expect(preview.lines).not.toEqual(plain.lines);
  });

  it('leaves fill blocks as they are', () => {
    const q = { name: 't', files: [fromSource('f.prg', '.pc = $c000\n rts\n.fill 64, $00')] };
    const A = analyze(q);
    expect(findBlock(A.blocks, 0xc001)?.type).toBe('fill');
    const R = render(A, q, { dataAsCode: true });
    expect(R.lines.some(l => 'preview' in l && l.preview)).toBe(false);
    expect(R.lines).toEqual(render(A, q).lines);
  });

  it('keeps bytes that end no instruction inside the block as .byte', () => {
    const q = { name: 't', files: [fromSource('j.prg', '.pc = $c000\n rts\n.byte $8d,$20')] };
    const R = render(analyze(q), q, { dataAsCode: true });
    const tail = R.lines.filter(l => (l.k === 'dat' || l.k === 'ins') && l.preview);
    expect(tail.map(l => l.k)).toEqual(['dat', 'dat']);
  });
});

describe('symbols', () => {
  it('resolves registers, mirrors, multi-byte symbols and screen positions', () => {
    expect(hwSymbol(0xd020)?.text).toBe('VIC_BORDER_COLOR');
    expect(hwSymbol(0xd060)?.text).toBe('VIC_BORDER_COLOR+$40');
    expect(hwSymbol(0x0315)?.text).toBe('CINV+1');
    expect(hwSymbol(0x0400 + 12 * 40 + 5)?.text).toBe('SCREEN_RAM+12*40+5');
    expect(hwSymbol(0xffd2)?.sym.call).toBe(true);
    expect(hwSymbol(0x9000)).toBeNull();
  });

  it(`prefers KERNAL names for calls and I/O names for data (${h4(0xd012)})`, () => {
    const { src } = run(fromSource('sym.prg', '.pc = $c000\n jsr $ffd2\n lda $d012\n rts'));
    expect(src).toContain('jsr CHROUT');
    expect(src).toMatch(/lda VIC_RASTER +\/\/ Raster line/);
  });
});
