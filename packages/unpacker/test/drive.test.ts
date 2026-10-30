/* The 1541: the D64 as GCR tracks the way the head reads them, the DOS reading every sector through its job queue,
 * and programs that load more files from the disk: through the KERNAL, and with drive code of their own (sent with
 * M-W, started with M-E) that reads a sector and sends it over the serial bus bit by bit. The drive tests need
 * VICE's ROMs and its 1541 DOS ROM; without them only the GCR is tested. */
import { describe, expect, it } from 'vitest';
import { unpack } from '../src/index.ts';
import { findRoms } from '../src/node.ts';
import { Drive } from '../src/drive.ts';
import { d64ToDisk, sectorsOn, TRACK_BYTES, zoneOf } from '../src/gcr.ts';
import { d64Directory, d64File, d64Pick } from '../src/d64.ts';
import { asm, byteLines, SYS_LINE } from './asm.ts';
import { makeD64 } from './disk.ts';
import { noise } from './packers.ts';

const roms = findRoms();
const withDrive = !!roms?.drive;

/** the sectors on a GCR track, decoded: header fields and the 256 data bytes, with both checksums checked */
function decodeTrack(t: Uint8Array): { track: number; sector: number; id: number[]; data: number[]; ok: boolean }[] {
  const nibble = new Map([0x0a, 0x0b, 0x12, 0x13, 0x0e, 0x0f, 0x16, 0x17, 0x09, 0x19, 0x1a, 0x1b, 0x0d, 0x1d, 0x1e, 0x15].map((g, i) => [g, i]));
  const decode = (from: number, n: number) => {
    let bits = '';
    for (let k = 0; k < Math.ceil((n * 10) / 8); k++) bits += t[(from + k) % t.length].toString(2).padStart(8, '0');
    return Array.from({ length: n }, (_, i) => (nibble.get(parseInt(bits.slice(i * 10, i * 10 + 5), 2))! << 4) | nibble.get(parseInt(bits.slice(i * 10 + 5, i * 10 + 10), 2))!);
  };
  const out = [];
  for (let p = 0; p < t.length; p++) {
    if (t[p] !== 0xff || t[(p + 1) % t.length] === 0xff || t[(p + t.length - 1) % t.length] !== 0xff) continue;
    const h = decode(p + 1, 8);
    if (h[0] !== 0x08) continue;
    // the data block: after the gap, the next SYNC
    let q = p + 11;
    while (t[q % t.length] !== 0xff) q++;
    while (t[(q + 1) % t.length] === 0xff) q++;
    const d = decode(q + 1, 258);
    const sum = d.slice(1, 257).reduce((a, b) => a ^ b, 0);
    out.push({ track: h[3], sector: h[2], id: [h[5], h[4]], data: d.slice(1, 257), ok: d[0] === 0x07 && sum === d[257] && h[1] === (h[2] ^ h[3] ^ h[4] ^ h[5]) });
  }
  return out;
}

const offset = (t: number, s: number) => { let n = 0; for (let k = 1; k < t; k++) n += sectorsOn(k); return (n + s) * 256; };
const sectorBytes = (d64: Uint8Array, t: number, s: number) => [...d64.subarray(offset(t, s), offset(t, s) + 256)];

describe('the disk as GCR', () => {
  const d64 = makeD64([{ name: 'NOISE', prg: noise(20000) }]);
  for (let i = 0; i < 683; i++) d64[i * 256 + 7] ^= i & 0xff;
  const disk = d64ToDisk(d64);

  it('has every sector of every track, in order, with its header, data and checksums', () => {
    for (const track of [1, 17, 18, 24, 25, 30, 31, 35]) {
      const t = disk.tracks[track]!;
      expect(t.length).toBe(TRACK_BYTES[zoneOf(track)]);
      const sectors = decodeTrack(t);
      expect(sectors.map(s => s.sector)).toEqual([...Array(sectorsOn(track)).keys()]);
      for (const s of sectors) {
        expect(s).toMatchObject({ track, ok: true, id: [0x55, 0x54] });
        expect(s.data).toEqual(sectorBytes(d64, track, s.sector));
      }
    }
    expect(disk).toMatchObject({ name: 'TEST DISK', id: 'UT' });
    expect(disk.tracks[36]).toBeNull();
  });

  it('writes the errors of a D64 with error bytes into the sectors', () => {
    const errors = new Uint8Array(683).fill(1);
    errors[offset(1, 3) / 256] = 5; // 23: data checksum
    errors[offset(1, 4) / 256] = 2; // 20: no header
    const sectors = decodeTrack(d64ToDisk(Uint8Array.from([...d64, ...errors])).tracks[1]!);
    expect(sectors.find(s => s.sector === 3)!.ok).toBe(false);
    expect(sectors.map(s => s.sector)).not.toContain(4);
    expect(sectors.filter(s => s.ok)).toHaveLength(19);
  });

  it('reads the directory and files back', () => {
    const prg = noise(1000, 7);
    const disk = makeD64([{ name: 'FIRST', prg: asm(`${SYS_LINE}\nrts`).prg }, { name: 'SECOND', prg }]);
    expect(d64Directory(disk).map(e => [e.name, e.type, e.blocks])).toEqual([['FIRST', 'PRG', 1], ['SECOND', 'PRG', 4]]);
    expect([...d64File(disk, d64Pick(disk, 'SEC*')!)]).toEqual([...prg]);
    expect(d64Pick(disk)!.name).toBe('FIRST');
    expect(d64Pick(disk, 'THIRD')).toBeNull();
  });
});

describe.skipIf(!withDrive)('the 1541', () => {
  it('starts up and reads sectors anywhere on the disk through its DOS', () => {
    const d64 = makeD64([{ name: 'NOISE', prg: noise(60000, 3) }]);
    const d = new Drive(roms!.drive!);
    while (d.cycles < 2_500_000) d.step();
    d.insert(d64ToDisk(d64));
    for (const [t, s] of [[18, 0], [1, 0], [17, 20], [24, 18], [35, 16], [2, 9]]) {
      d.ram[0x06] = t; d.ram[0x07] = s; d.ram[0x00] = 0x80;
      const start = d.cycles;
      while (d.ram[0] >= 0x80 && d.cycles - start < 3_000_000) d.step();
      expect(d.ram[0], `track ${t} sector ${s}`).toBe(1);
      expect([...d.ram.subarray(0x300, 0x400)]).toEqual(sectorBytes(d64, t, s));
    }
  });
});

/** a program at $c000 behind a little data: the file the boot program loads */
const PART2 = asm(`
* = $c000
loop:  inc $d020
       dec $d021
       jmp loop
${byteLines(noise(600, 9))}
`);

/** a boot file that loads PART2 through the KERNAL (LOAD "PART2",8,1) and jumps to it */
const KERNAL_BOOT = asm(`${SYS_LINE}
       lda #5
       ldx #<name
       ldy #>name
       jsr $ffbd
       lda #1
       ldx #8
       ldy #1
       jsr $ffba
       lda #0
       jsr $ffd5
       bcs fail
       jmp $c000
fail:  inc $d020
       jmp fail
name:  .text "PART2"
`);

/**
 * Drive code for $0500: it reads track 1 sector 0 into buffer 4 ($0700) through the job queue, pulls DATA low to
 * say it is ready, then sends the 256 bytes: a bit on DATA (low for 1) at every edge of CLK, which the C64 drives;
 * a last CLK pulse lets it go.
 */
const DRIVE_CODE = asm(`
* = $0500
       lda #1
       sta $0e
       lda #0
       sta $0f
       lda #$80
       sta $04
       cli
wait:  lda $04
       bmi wait
       sei
       lda #$02
       sta $1800
       ldy #0
byte:  lda $0700,y
       sta $85
       ldx #4
pair:
low:   lda $1800
       and #$04
       beq low
       jsr put
high:  lda $1800
       and #$04
       bne high
       jsr put
       dex
       bne pair
       iny
       bne byte
last:  lda $1800
       and #$04
       beq last
       lda #0
       sta $1800
       cli
       rts
put:   lda #0
       asl $85
       rol
       asl
       sta $1800
       rts
`).prg.subarray(2);

/** the DOS commands that send DRIVE_CODE (M-W, 32 bytes at a time) and start it (M-E), each with its length first */
function commands(code: Uint8Array, at: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < code.length; k += 32) {
    const part = [...code.subarray(k, k + 32)], a = at + k;
    out.push(6 + part.length, 0x4d, 0x2d, 0x57, a & 0xff, a >> 8, part.length, ...part);
  }
  out.push(5, 0x4d, 0x2d, 0x45, at & 0xff, at >> 8, 0);
  return out;
}

/** a boot file that sends the drive code over the command channel, then takes the sector to $c000 and runs it */
const FAST_BOOT = asm(`${SYS_LINE}
       lda #0
       jsr $ffbd
       lda #15
       ldx #8
       ldy #15
       jsr $ffba
       jsr $ffc0
       ldx #0
next:  lda cmds,x
       beq sent
       sta $fb
       inx
       stx $fc
       ldx #15
       jsr $ffc9
send:  ldx $fc
       lda cmds,x
       jsr $ffd2
       inc $fc
       dec $fb
       bne send
       jsr $ffcc
       ldx $fc
       jmp next
sent:  sei
       lda $dd00
       and #$07
       sta $fd
       sta $dd00
       ldx #0
pause: dex
       bne pause
ready: bit $dd00
       bmi ready
       ldy #0
rbyte: ldx #4
rpair: lda $fd
       ora #$10
       sta $dd00
       jsr delay
       lda $dd00
       eor #$80
       asl
       rol $fe
       lda $fd
       sta $dd00
       jsr delay
       lda $dd00
       eor #$80
       asl
       rol $fe
       dex
       bne rpair
       lda $fe
       sta $c000,y
       iny
       bne rbyte
       lda $fd
       ora #$10
       sta $dd00
       jsr delay
       lda $fd
       sta $dd00
       cli
       jmp $c000
delay: lda #12
       sta $fb
dl:    dec $fb
       bne dl
       rts
cmds:
${byteLines(commands(DRIVE_CODE, 0x0500))}
`);

describe.skipIf(!withDrive)('programs that load from the disk', () => {
  it('follows a KERNAL LOAD of the next file through the drive', () => {
    const disk = makeD64([{ name: 'BOOT', prg: KERNAL_BOOT.prg }, { name: 'PART2', prg: PART2.prg }]);
    const r = unpack(KERNAL_BOOT.prg, { roms, disk });
    expect(r.drive).toMatch(/^1541 with "TEST DISK" UT, \d+ bytes read$/);
    expect(r.layers.map(l => l.entry)).toEqual([0x080d, 0xc000]);
    expect(r.saved).toMatchObject({ entry: 0xc000, start: 0xc000, end: PART2.end });
    expect([...r.saved!.prg]).toEqual([...PART2.prg]);
  });

  it('follows drive code of the program\'s own that sends a sector over the serial bus', () => {
    const sector = PART2.prg.subarray(2, 258);
    const disk = makeD64([{ name: 'BOOT', prg: FAST_BOOT.prg }], [{ track: 1, sector: 0, bytes: sector }]);
    const r = unpack(FAST_BOOT.prg, { roms, disk });
    expect(r.layers.map(l => l.entry)).toEqual([0x080d, 0xc000]);
    expect(r.saved).toMatchObject({ entry: 0xc000, start: 0xc000, end: 0xc0ff });
    expect([...r.saved!.prg.subarray(2)]).toEqual([...sector]);
  });

  it('stops at the load without a disk, or without the DOS ROM', () => {
    const disk = makeD64([{ name: 'BOOT', prg: KERNAL_BOOT.prg }, { name: 'PART2', prg: PART2.prg }]);
    const none = unpack(KERNAL_BOOT.prg, { roms });
    expect(none.stop).toMatchObject({ reason: 'load', detail: 'loads "PART2" from device 8' });
    expect(none.drive).toBeNull();
    const noDos = unpack(KERNAL_BOOT.prg, { roms: { ...roms!, drive: undefined }, disk });
    expect(noDos.stop.reason).toBe('load');
    expect(noDos.drive).toBe('no 1541 DOS ROM: the disk was not used');
    expect(unpack(KERNAL_BOOT.prg, { roms: null, disk }).drive).toBe('the stand-ins have no serial bus: the disk was not used');
  });
});
