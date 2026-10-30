/* The 1541 disk drive on the serial bus: its own 6502 with 2 KB of RAM, the DOS ROM (from VICE, never shipped),
 * VIA 1 on the serial bus and VIA 2 on the read/write head, and a disk turning under the head at 300 rpm.
 *
 * It runs behind the C64, cycle for cycle at its own 1 MHz: whenever the C64 reads or writes the serial port
 * ($dd00) the drive first catches up to that moment, running every instruction whose bus access comes before the
 * C64's. So both see the lines change in the order a real C64 and 1541 would, which fast loaders that count cycles
 * depend on.
 *
 * The serial bus: ATN, CLK and DATA are open-collector lines, low when either side pulls them. VIA 1 port B: bit 0
 * DATA in, bit 1 DATA out, bit 2 CLK in, bit 3 CLK out, bit 4 ATN acknowledge, bits 5-6 the device number (8),
 * bit 7 ATN in (the inputs read 1 while a line is low); CA1 sees ATN. The drive pulls DATA low by itself while ATN
 * and the acknowledge bit differ. VIA 2: port A the GCR byte under the head, port B bits 0-1 the stepper, bit 2 the
 * motor, bit 3 the LED, bit 4 write protect, bits 5-6 the density, bit 7 SYNC (0 while the head is over one); CA1
 * byte ready, which also sets the CPU's overflow flag while CA2 is high; CB2 low writes. */
import { Cpu, type Bus } from './cpu.ts';
import { BYTE_CYCLES, type Disk } from './gcr.ts';
import { CYCLES } from './opcodes.ts';
import { Via, type ViaState } from './via.ts';

/** drive cycles per C64 cycle (1 MHz against PAL's 985248 Hz) */
export const DRIVE_RATIO = 1_000_000 / 985248;

export interface DriveState {
  ram: Uint8Array; cpu: { a: number; x: number; y: number; s: number; pc: number; p: number };
  via1: ViaState; via2: ViaState; cycles: number; halftrack: number; phase: number;
}

export class Drive implements Bus {
  readonly ram = new Uint8Array(0x800);
  readonly via1 = new Via();
  readonly via2 = new Via();
  readonly cpu: Cpu;
  readonly rom: Uint8Array;
  disk: Disk | null = null;
  /** drive cycles since power-on */
  cycles = 0;
  /** the head: half tracks from 2 (track 1) to 84 (track 42), and the stepper phase that put it there */
  halftrack = 36;
  private phase = 0;
  /** the byte under the head, its position on the track, and the cycles towards the next one */
  private pos = 0;
  private rot = 0;
  private latch = 0;
  private sync = false;
  /** the lines the C64 pulls low */
  c64Atn = false; c64Clk = false; c64Data = false;
  /** bytes the head read and wrote, for the report */
  bytesRead = 0;
  bytesWritten = 0;

  constructor(rom: Uint8Array) {
    if (rom.length !== 0x4000) throw new Error(`a 1541 DOS ROM has 16 KB, not ${rom.length} bytes`);
    this.rom = rom;
    this.cpu = new Cpu(this);
    this.via1.inputB = () => (this.dataLow ? 0x01 : 0) | (this.clkLow ? 0x04 : 0) | (this.c64Atn ? 0x80 : 0);
    this.via2.inputA = () => this.latch;
    this.via2.inputB = () => (this.sync ? 0 : 0x80) | (this.disk?.writeProtected ? 0 : 0x10);
    this.via2.changedB = () => this.step2();
    this.reset();
  }

  reset(): void {
    const c = this.cpu;
    c.s = 0xfd; c.p = 0x24; c.jammed = false;
    c.pc = this.read(0xfffc) | (this.read(0xfffd) << 8);
  }

  /** the spindle motor runs (VIA 2 port B bit 2): the drive is loading or about to */
  get motorOn(): boolean { return (this.via2.outB & 0x04) !== 0; }

  /**
   * Insert the disk and have the DOS read a header on track 18, as it does when the C64 loads the file: then it
   * knows the disk's ID, which reading a sector through the job queue checks (code a loader sends with M-E does).
   */
  insert(disk: Disk): void {
    this.disk = disk;
    const ram = this.ram, start = this.cycles;
    ram[0x06] = 18; ram[0x07] = 0; ram[0x00] = 0xb0;
    while (ram[0x00] >= 0x80 && this.cycles - start < 3_000_000) this.step();
  }

  // --- the bus lines --------------------------------------------------------------------------------------------
  get atnLow(): boolean { return this.c64Atn; }
  get clkLow(): boolean { return this.c64Clk || (this.via1.outB & 0x08) !== 0; }
  get dataLow(): boolean { const b = this.via1.outB; return this.c64Data || (b & 0x02) !== 0 || this.c64Atn !== ((b & 0x10) !== 0); }

  /** The C64 changed its serial outputs (true: it pulls the line low). */
  setC64(atn: boolean, clk: boolean, data: boolean): void {
    this.c64Clk = clk; this.c64Data = data;
    if (atn !== this.c64Atn) { this.c64Atn = atn; this.via1.setCa1(atn); }
  }

  // --- memory ---------------------------------------------------------------------------------------------------
  read(a: number): number {
    if (a < 0x1800) return this.ram[a & 0x7ff];
    if (a < 0x1c00) return this.via1.read(a & 0x0f);
    if (a < 0x2000) return this.via2.read(a & 0x0f);
    if (a >= 0x8000) return this.rom[a & 0x3fff];
    return a >> 8;
  }

  fetch(a: number): number { return a < 0x1800 ? this.ram[a & 0x7ff] : a >= 0x8000 ? this.rom[a & 0x3fff] : this.read(a); }

  write(a: number, v: number): void {
    if (a < 0x1800) this.ram[a & 0x7ff] = v;
    else if (a < 0x1c00) this.via1.write(a & 0x0f, v);
    else if (a < 0x2000) this.via2.write(a & 0x0f, v);
  }

  // --- running --------------------------------------------------------------------------------------------------
  /**
   * One instruction (or an interrupt), with the time it takes passing for the VIAs and the disk. The cycles before
   * the instruction's bus access pass first, so that it reads the byte under the head, the timers and the overflow
   * flag as they are in that cycle (a GCR decoder that reads the head without waiting depends on it).
   */
  step(): number {
    const c = this.cpu;
    let n: number;
    if (!c.i && (this.via1.irq || this.via2.irq)) { n = c.irq(); this.pass(n); }
    else {
      const before = CYCLES[this.fetch(c.pc)] - 1;
      this.pass(before);
      // a JAM stops the drive's CPU for good, as on the real drive; the VIAs and the disk go on
      n = c.step() || 2;
      this.pass(n - before);
    }
    this.cycles += n;
    return n;
  }

  private pass(n: number): void {
    if (n <= 0) return;
    this.via1.advance(n);
    this.via2.advance(n);
    this.turn(n);
  }

  /** Run every instruction whose bus access comes before drive cycle `target`. */
  runUntil(target: number): void {
    const c = this.cpu;
    while (this.cycles + CYCLES[this.fetch(c.pc)] - 1 < target) this.step();
  }

  // --- the head and the disk -------------------------------------------------------------------------------------
  private track(): Uint8Array | null {
    return this.halftrack & 1 ? null : this.disk?.tracks[this.halftrack >> 1] ?? null;
  }

  /** VIA 2 port B changed: the stepper moves the head half a track in or out */
  private step2(): void {
    const p = this.via2.outB & 3;
    if (p === this.phase) return;
    const before = this.track()?.length ?? 0;
    if (p === ((this.phase + 1) & 3)) this.halftrack = Math.min(84, this.halftrack + 1);
    else if (p === ((this.phase - 1) & 3)) this.halftrack = Math.max(2, this.halftrack - 1);
    this.phase = p;
    // the disk keeps turning: the head lands at the same angle on the new track
    const after = this.track()?.length ?? 0;
    if (before && after) this.pos = Math.floor((this.pos * after) / before);
  }

  /** n drive cycles of the disk turning under the head (while the motor runs) */
  private turn(n: number): void {
    const b = this.via2.outB;
    if (!(b & 0x04)) return;
    const per = BYTE_CYCLES[(b >> 5) & 3];
    this.rot += n;
    while (this.rot >= per) { this.rot -= per; this.nextByte(); }
  }

  private nextByte(): void {
    const t = this.track(), v2 = this.via2;
    const writing = !v2.cb2;
    if (!t) { this.sync = false; this.latch = 0; this.ready(); return; }
    this.pos = (this.pos + 1) % t.length;
    if (writing) {
      t[this.pos] = v2.outA;
      this.bytesWritten++;
      this.sync = false;
      this.ready();
      return;
    }
    const byte = t[this.pos];
    // SYNC: the head over at least ten 1 bits in a row; no byte is ready meanwhile
    this.sync = byte === 0xff && t[(this.pos + t.length - 1) % t.length] === 0xff;
    if (this.sync) return;
    this.latch = byte;
    this.bytesRead++;
    this.ready();
  }

  /** a byte is ready: VIA 2's CA1 flag, and the CPU's overflow flag while byte ready is enabled (CA2 high) */
  private ready(): void {
    this.via2.ifr |= 0x02;
    if (this.via2.ca2) this.cpu.v = 1;
  }

  // --- state ----------------------------------------------------------------------------------------------------
  save(): DriveState {
    const c = this.cpu;
    return {
      ram: this.ram.slice(), cpu: { a: c.a, x: c.x, y: c.y, s: c.s, pc: c.pc, p: c.p },
      via1: this.via1.save(), via2: this.via2.save(), cycles: this.cycles, halftrack: this.halftrack, phase: this.phase,
    };
  }

  restore(s: DriveState): void {
    this.ram.set(s.ram);
    const c = this.cpu;
    c.a = s.cpu.a; c.x = s.cpu.x; c.y = s.cpu.y; c.s = s.cpu.s; c.pc = s.cpu.pc; c.p = s.cpu.p;
    this.via1.restore(s.via1); this.via2.restore(s.via2);
    this.cycles = s.cycles; this.halftrack = s.halftrack; this.phase = s.phase;
  }
}
