/* Packed programs: a decruncher stub in front of compressed data is reported, plain programs are not.
 * (The thresholds were calibrated on a few hundred PRGs from the CSDB archive, see src/packing.ts.) */
import { describe, expect, it } from 'vitest';
import { analyze, detectPacking, makeDemo, OPC, packerSignature, parsePrg } from '../src';
import { allOpcodesProgram, fromSource } from './helpers/programs';

/** 10 SYS2061, a decruncher that copies itself to $0100 and jumps there, then `data` from $0830 */
function packedPrg(data: Uint8Array) {
  const stub = fromSource('stub.prg', '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n sei\n ldx #0\nl: lda $0830,x\n sta $0100,x\n inx\n bne l\n jmp $0100\n.pc = $082f\n .byte 0');
  const bytes = new Uint8Array(0x0830 - 0x0801 + data.length);
  bytes.set(stub.bytes);
  bytes.set(data, 0x0830 - 0x0801);
  return { name: 'packed.prg', load: 0x0801, bytes };
}
const random = (n: number, values = 256, seed = 7) => { let x = seed; return Uint8Array.from({ length: n }, () => { x = (x * 1103515245 + 12345) >>> 0; return (x >>> 16) % values; }); };
const check = (f: { name: string; load: number; bytes: Uint8Array }) => detectPacking(analyze({ name: 'p', files: [f] }));

describe('packing', () => {
  it('reports a decruncher in front of compressed data', () => {
    const r = check(packedPrg(random(8192)));
    expect(r).toMatchObject({ verdict: 'packed', decruncher: 0x080d, signature: null });
    expect(r!.packedShare).toBeGreaterThan(0.9);
    expect(r!.entropy).toBeGreaterThan(7.9);
    expect(r!.codeBytes).toBeLessThan(40);
    expect(r!.reasons.join(' | ')).toMatch(/% of the file looks compressed.*bits of entropy per byte outside the code.*only \d+ bytes of code can be traced/);
  });

  it('counts older crunchers (less entropy) as packed when they say so, and as maybe when they do not', () => {
    // ~6.6 bits per byte: what byte-oriented crunchers of the 80s leave
    const old = random(6000, 100);
    expect(check(packedPrg(old))).toMatchObject({ verdict: 'maybe', packedShare: 0 });
    const said = Uint8Array.from([...old.slice(0, 3000), ...new TextEncoder().encode('CRUNCHED BY TIME CRUNCHER'), ...old.slice(3000)]);
    expect(check(packedPrg(said))).toMatchObject({ verdict: 'packed', signature: 'Time Cruncher' });
  });

  it('leaves plain programs alone', () => {
    const d = makeDemo();
    expect(check(parsePrg(d.name, d.prg))).toBeNull();
    expect(check(allOpcodesProgram(OPC))).toBeNull();
    // too small to tell
    expect(check(packedPrg(random(500)))).toBeNull();
  });

  it('finds packer names in ASCII, PETSCII and screen codes', () => {
    const enc = new TextEncoder();
    expect(packerSignature(enc.encode('xx exomizer 3.1 xx'))).toBe('Exomizer');
    expect(packerSignature(Uint8Array.from('PUCRUNCH'.split('').map(c => c.charCodeAt(0) - 64)))).toBe('PuCrunch'); // screen codes
    expect(packerSignature(Uint8Array.from('BYTEBOOZER'.split('').map(c => c.charCodeAt(0) + 0x80)))).toBe('ByteBoozer'); // shifted PETSCII
    expect(packerSignature(enc.encode('PACKED WITH SOMETHING'))).toBe('a cruncher');
    expect(packerSignature(enc.encode('a demo by dalinda'))).toBeNull();
    expect(packerSignature(random(4000))).toBeNull();
  });
});
