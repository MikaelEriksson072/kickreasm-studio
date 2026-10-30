/* Test packers: an RLE cruncher whose 6502 decruncher can sit anywhere and end in different ways, a stub that moves
 * the packed data to $c000, an XOR coder around it, and an intro that waits for space first. */
import { asm, byteLines, SYS_LINE, type Assembled } from './asm.ts';

export const ESC = 0xbb;

/** RLE: ESC count value for runs (and for ESC itself), ESC 0 at the end */
export function rle(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length;) {
    let n = 1;
    while (i + n < data.length && data[i + n] === data[i] && n < 255) n++;
    if (n >= 4 || data[i] === ESC) { out.push(ESC, n, data[i]); i += n; } else { out.push(data[i]); i++; }
  }
  out.push(ESC, 0);
  return Uint8Array.from(out);
}

/** bytes that do not pack (a fixed pseudo-random sequence) */
export function noise(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) >>> 0; out[i] = seed >>> 24; }
  return out;
}

/** The program the tests pack: it fills the screen and loops changing the background colour. */
export const PROGRAM = asm(`
* = $1000
       lda #0
       sta $d020
       ldx #0
fill:  txa
       sta $0400,x
       inx
       bne fill
loop:  inc $d021
       jmp loop
       .text "THIS IS THE UNPACKED PROGRAM"
       .fill 300, $00
       .fill 40, $41
       .byte 1,2,3,4,5,6,7,8,9,$bb,$bb
       .fill 200, $ee
${byteLines(noise(400))}
       .text "END"
`);

export type Exit = 'jmp' | 'rts' | 'basic';

/** the RLE decruncher, at `at`, reading the packed data at `src` and writing to `dest` */
export function decruncher(at: number, src: number, dest: number, exit: Exit, entry: number): Uint8Array {
  // (a BASIC program's end goes to $2d/$2e, as BASIC's LOAD would set it)
  const tail = exit === 'jmp' ? `jmp ${entry}` : exit === 'rts' ? 'rts' : 'lda $fd\n sta $2d\n lda $fe\n sta $2e\n jsr $a659\n jmp $a7ae';
  return asm(`
* = ${at}
       lda #<${src}
       sta $fb
       lda #>${src}
       sta $fc
       lda #<${dest}
       sta $fd
       lda #>${dest}
       sta $fe
       ldy #0
next:  jsr get
       cmp #${ESC}
       bne lit
       jsr get
       tax
       beq done
       jsr get
run:   jsr put
       dex
       bne run
       beq next
lit:   jsr put
       jmp next
get:   lda ($fb),y
       inc $fb
       bne g1
       inc $fc
g1:    rts
put:   sta ($fd),y
       inc $fd
       bne p1
       inc $fe
p1:    rts
done:  lda #$37
       sta $01
       ${tail}
`).prg.subarray(2);
}

export interface PackOptions {
  /** where the decruncher runs (default $0100) */
  at?: number;
  /** jmp: it jumps to the program; rts: the stub calls it with JSR and jumps itself; basic: it starts BASIC's RUN */
  exit?: Exit;
  /** code to run first (an intro), at $080d */
  before?: string;
}

/** The stub at $080d: moves the packed data to $c000, copies the decruncher to its place and starts it. */
export function pack(program: { prg: Uint8Array }, o: PackOptions = {}): Assembled {
  const at = o.at ?? 0x0100, exit = o.exit ?? 'jmp';
  const dest = program.prg[0] | (program.prg[1] << 8);
  const entry = exit === 'basic' ? 0 : dest;
  const packed = rle(program.prg.subarray(2));
  const dec = decruncher(at, 0xc000, dest, exit === 'rts' ? 'rts' : exit, entry);
  const pages = Math.ceil(packed.length / 256);
  const start = exit === 'rts' ? `jsr ${at}
       jmp ${entry}` : `jmp ${at}`;
  return asm(`${SYS_LINE}
${o.before ?? ''}
       sei
       ldx #${pages}
       ldy #0
mv:    lda packed,y
       sta $c000,y
       iny
       bne mv
       inc mv+2
       inc mv+5
       dex
       bne mv
       ldx #0
cp:    lda decsrc,x
       sta ${at},x
       inx
       cpx #${dec.length}
       bne cp
       ${start}
decsrc:
${byteLines(dec)}
packed:
${byteLines(packed)}
`);
}

/**
 * An XOR coder at $080d in front of the stub: it decrypts the stub and its data in place, a page at a time, and
 * then runs on into the code it decrypted.
 */
export function coded(program: { prg: Uint8Array }, key = 0x5a, o: PackOptions = {}): Uint8Array {
  const coder = (pages: number) => `
       ldx #0
cl:    lda go,x
       eor #${key}
       sta go,x
       inx
       bne cl
       inc cl+2
       inc cl+7
       dec count
       bne cl
       jmp go
count: .byte ${pages}
go:`;
  const first = pack(program, { ...o, before: coder(1) });
  const pages = Math.ceil((first.end + 1 - first.labels.go) / 256);
  const built = pack(program, { ...o, before: coder(pages) });
  const prg = built.prg.slice();
  for (let a = built.labels.go; a <= built.end; a++) prg[a - built.start + 2] ^= key;
  return prg;
}
