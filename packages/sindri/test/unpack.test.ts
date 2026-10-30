import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { unpack, type UnpackResult } from '../src/index.ts';
import { findRoms } from '../src/node.ts';
import { asm, byteLines, SYS_LINE } from './asm.ts';
import { coded, pack, PROGRAM } from './packers.ts';

const roms = findRoms();
const body = PROGRAM.prg.subarray(2);

function expectProgram(r: UnpackResult): void {
  expect(r.unpacked).toBe(true);
  const s = r.saved!;
  expect(s.entry).toBe(0x1000);
  expect(s.start).toBe(0x1000);
  expect(s.end).toBe(0x1000 + body.length - 1);
  expect([...s.prg.subarray(2)]).toEqual([...body]);
}

/** a program that writes code and calls it every frame, and installs an interrupt handler it wrote */
const WRITES_CODE = asm(`
* = $1000
       sei
       ldx #8
copy:  lda irq,x
       sta $2100,x
       dex
       bpl copy
       ldx #3
copy2: lda speed,x
       sta $2000,x
       dex
       bpl copy2
       lda #$00
       sta $0314
       lda #$21
       sta $0315
       cli
loop:  jsr $2000
       jmp loop
speed: inc $d020
       rts
irq:   inc $d019
       nop
       nop
       nop
       jmp $ea31
`);

for (const mode of roms ? ['stand-ins', 'ROMs'] as const : ['stand-ins'] as const) {
  const go = (prg: Uint8Array) => unpack(prg, { roms: mode === 'ROMs' ? roms : null });

  describe(`unpacking with the ${mode}`, () => {
    it('follows a decruncher that runs at $0100 to the program', () => {
      const r = go(pack(PROGRAM).prg);
      expectProgram(r);
      expect(r.layers.map(l => [l.entry, l.kind])).toEqual([[0x080d, 'mover'], [0x0100, 'decruncher'], [0x1000, 'program']]);
      expect(r.stop.reason).toBe('settled');
    });

    it('finds a decruncher that never goes below $0800', () => {
      const r = go(pack(PROGRAM, { at: 0xc800 }).prg);
      expectProgram(r);
      expect(r.layers[1].entry).toBe(0xc800);
    });

    it('joins a decruncher called with JSR to the stub that called it', () => {
      const r = go(pack(PROGRAM, { exit: 'rts' }).prg);
      expectProgram(r);
      expect(r.layers).toHaveLength(2);
      expect(r.layers[0].calls).toContainEqual({ entry: 0x0100, via: 'jsr' });
    });

    it('gets through an XOR coder that runs on into the code it decrypted', () => {
      expectProgram(go(coded(PROGRAM)));
    });

    it('presses space for an intro that waits before it decrunches', () => {
      const r = go(pack(PROGRAM, { before: 'lda #0\n sta $dc00\nwait: lda $dc01\n cmp #$ef\n bne wait' }).prg);
      expectProgram(r);
      expect(r.layers[0].presses[0]).toMatch(/^space \+ fire/);
    });

    it('saves a BASIC program a depacker starts with RUN', () => {
      const basicProgram = asm(`${SYS_LINE}
loop:  inc $d020
       jmp loop
       .fill 200, $11
`);
      const r = go(pack(basicProgram, { exit: 'basic' }).prg);
      expect(r.unpacked).toBe(true);
      const s = r.saved!;
      expect(s).toMatchObject({ basic: true, entry: 0x080d, start: 0x0801 });
      expect([...s.prg.subarray(2, 2 + basicProgram.prg.length - 2)]).toEqual([...basicProgram.prg.subarray(2)]);
    });

    it('does not take code the program writes and calls for a new layer', () => {
      const r = go(pack(WRITES_CODE).prg);
      expect(r.saved!.entry).toBe(0x1000);
      expect(r.layers.at(-1)!.calls.map(c => c.entry)).toEqual(expect.arrayContaining([0x2000]));
    });

    it('starts a file that loads over the BASIC vectors by itself', () => {
      const code = asm(`
* = $1000
loop:  inc $d020
       jmp loop`).prg.subarray(2);
      const file = asm(`
* = $02a7
start: ldx #${code.length - 1}
cp:    lda payload,x
       sta $1000,x
       dex
       bpl cp
       jmp $1000
* = $0300
       .word $e38b, start, $a57c, $a71a, $a7e4, $ae86
       .byte 0, 0, 0, 0, $4c, $48, $b2, 0
       .word $ea31, $fe66, $fe47, $f34a, $f291, $f20e, $f250, $f333, $f157, $f1ca, $f6ed, $f13e, $f32f, $fe66, $f4a5, $f5ed
payload:
${byteLines(code)}
`);
      const r = go(file.prg);
      expect(r.layers[0].entry).toBe(0x02a7);
      expect(r.saved).toMatchObject({ entry: 0x1000, start: 0x1000 });
    });

    it('says when nothing was unpacked', () => {
      const r = go(asm(`${SYS_LINE}\nloop: inc $d020\n jmp loop`).prg);
      expect(r.unpacked).toBe(false);
      expect(r.saved).toBeNull();
      expect(r.layers).toHaveLength(1);
    });
  });
}

const EXOMIZER = ['C:\\C64\\exomizer-3.1.1\\win32\\exomizer.exe', '/usr/bin/exomizer', '/usr/local/bin/exomizer'].find(p => existsSync(p));

describe.skipIf(!EXOMIZER)('Exomizer', () => {
  it('unpacks an Exomizer 3 self-extracting file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sindri-exo-'));
    try {
      writeFileSync(join(dir, 'in.prg'), PROGRAM.prg);
      const p = spawnSync(EXOMIZER!, ['sfx', '0x1000', '-q', '-o', 'out.prg', 'in.prg'], { cwd: dir, encoding: 'utf8' });
      expect(p.status, p.stderr).toBe(0);
      const packed = new Uint8Array(readFileSync(join(dir, 'out.prg')));
      for (const r of [unpack(packed, { roms: null }), ...(roms ? [unpack(packed, { roms })] : [])]) {
        expect(r.saved!.entry).toBe(0x1000);
        const s = r.saved!;
        expect([...s.prg.subarray(2 + 0x1000 - s.start, 2 + 0x1000 - s.start + body.length)]).toEqual([...body]);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
