/* A small but real packer for the tests: the program's bytes xor a 16-bit Galois LFSR key stream (so the packed
 * data looks compressed, ~8 bits/byte), behind 10 SYS2061 and a decruncher that a C64 (and unp64, which emulates
 * one) really runs: it copies its loop to $0340, decodes the data into place and jumps to the program.
 *
 *   $0801 BASIC stub · $080d mover · $0850 decoder (copied to $0340) · $0900 "FAKEPACK", start, load, length, data
 *
 * fake-unp64.cjs undoes it without emulating, the way unp64 names its result (`<input>.<start>`). */
import { fileURLToPath } from 'node:url';
import { h2, h4, makePrg } from '../../src';
import { fromSource } from './programs';

export const FAKE_UNP64 = fileURLToPath(new URL('./fake-unp64.cjs', import.meta.url));

/** the key stream: s = $ace1; per byte s >>= 1 (xor $b400 when a 1 falls out), key = low byte */
export function keyStream(n: number): Uint8Array {
  let s = 0xace1;
  return Uint8Array.from({ length: n }, () => { const lsb = s & 1; s >>= 1; if (lsb) s ^= 0xb400; return s & 0xff; });
}

const HEADER = 0x0900, DATA = HEADER + 14;

export function fakePack(prg: Uint8Array, entry: number): Uint8Array {
  const load = prg[0] | (prg[1] << 8), body = prg.subarray(2), n = body.length;
  // decoding runs forward into place: the program may not start after its packed data or cover the loop at $0340
  if (load > DATA || (load < 0x0380 && load + n > 0x0340)) throw new Error('fakePack: the program must load at or below $090e and clear of $0340-$037f');
  const lo = (v: number) => `$${h2(v & 0xff)}`, hi = (v: number) => `$${h2(v >> 8)}`;
  const stub = fromSource('stub.prg', `
.pc = $0801
.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00
.pc = $080d
 sei
 ldx #$3f
copy:
 lda $0850,x
 sta $0340,x
 dex
 bpl copy
 lda #${lo(DATA)}
 sta $fb
 lda #${hi(DATA)}
 sta $fc
 lda #${lo(load)}
 sta $fd
 lda #${hi(load)}
 sta $fe
 lda #${lo(n)}
 sta $22
 lda #${hi(n)}
 sta $23
 lda #$e1
 sta $24
 lda #$ac
 sta $25
 jmp $0340
.pc = $0850
next:
 lsr $25
 ror $24
 bcc key
 lda $25
 eor #$b4
 sta $25
key:
 ldy #$00
 lda ($fb),y
 eor $24
 sta ($fd),y
 inc $fb
 bne s1
 inc $fc
s1:
 inc $fd
 bne s2
 inc $fe
s2:
 lda $22
 bne s3
 dec $23
s3:
 dec $22
 lda $22
 ora $23
 bne next
 cli
 jmp $${h4(entry)}
.pc = $08ff
 .byte $00`);
  if (stub.load !== 0x0801 || stub.bytes.length !== HEADER - 0x0801) throw new Error('fakePack: the stub does not end at $08ff');
  const k = keyStream(n);
  const header = [...new TextEncoder().encode('FAKEPACK'), entry & 0xff, entry >> 8, load & 0xff, load >> 8, n & 0xff, n >> 8];
  return makePrg(0x0801, Uint8Array.from([...stub.bytes, ...header, ...body.map((v, i) => v ^ k[i])]));
}
