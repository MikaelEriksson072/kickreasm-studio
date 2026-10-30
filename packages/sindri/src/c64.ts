/* The emulated C64: 64 KB RAM, the ROMs banked by $00/$01, the VIC-II (raster line, raster IRQ, badlines), both
 * CIAs (timers, interrupts, keyboard and joysticks, TOD), the SID registers the CPU can read, and colour RAM.
 * It is as exact as unpacking needs: whole instructions, a PAL timing of 63 cycles x 312 lines. A 1541 can be put on
 * the serial bus (drive.ts); without one nothing answers there.
 *
 * It also records, for every RAM address, which layer wrote it last and when, and when it was last read as data.
 * Sindri finds the layers of a packed program from that. */
import { Cpu, type Bus } from './cpu.ts';
import { DRIVE_RATIO, type Drive } from './drive.ts';
import { CYCLES } from './opcodes.ts';

/** what a 256-byte page reads from */
export const RAM = 0, ZP = 1, BASIC = 2, KERNAL = 3, CHAR = 4, IO = 5;

/** layer tags: written while the C64 started, and the bytes of the loaded file */
export const BOOT = -2, LOADED = -1;

export const CYCLES_PER_LINE = 63, LINES = 312;
export const CYCLES_PER_FRAME = CYCLES_PER_LINE * LINES;
/** PAL: 985248 Hz */
export const CLOCK = 985248;

export class Vic {
  readonly regs = new Uint8Array(0x40);
  line = 0;
  lineCycle = 0;
  compare = 0;
  flags = 0;
  /** DEN was set on line $30, so this frame has badlines */
  private den = true;

  read(r: number): number {
    switch (r) {
      case 0x11: return (this.regs[0x11] & 0x7f) | ((this.line & 0x100) >> 1);
      case 0x12: return this.line & 0xff;
      case 0x16: return this.regs[0x16] | 0xc0;
      case 0x18: return this.regs[0x18] | 0x01;
      case 0x19: return this.flags | 0x70 | (this.flags & this.regs[0x1a] & 0x0f ? 0x80 : 0);
      case 0x1a: return this.regs[0x1a] | 0xf0;
      case 0x1e: case 0x1f: { const v = this.regs[r]; this.regs[r] = 0; return v; }
    }
    if (r >= 0x2f) return 0xff;
    if (r >= 0x20) return this.regs[r] | 0xf0;
    return this.regs[r];
  }

  write(r: number, v: number): void {
    switch (r) {
      case 0x11: this.regs[0x11] = v; this.compare = (this.compare & 0xff) | ((v & 0x80) << 1); return;
      case 0x12: this.compare = (this.compare & 0x100) | v; return;
      case 0x19: this.flags &= ~v & 0x0f; return;
      case 0x1e: case 0x1f: return;
    }
    if (r < 0x2f) this.regs[r] = v;
  }

  get irq(): boolean { return (this.flags & this.regs[0x1a] & 0x0f) !== 0; }

  /** Let n cycles pass; returns the cycles the CPU loses to badlines on the lines that start meanwhile. */
  advance(n: number): number {
    let stolen = 0;
    this.lineCycle += n;
    while (this.lineCycle >= CYCLES_PER_LINE) {
      this.lineCycle -= CYCLES_PER_LINE;
      const line = this.line = this.line === LINES - 1 ? 0 : this.line + 1;
      if (line === 0x30) this.den = (this.regs[0x11] & 0x10) !== 0;
      if (line === this.compare) this.flags |= 1;
      if (this.den && line >= 0x30 && line <= 0xf7 && (line & 7) === (this.regs[0x11] & 7)) {
        stolen += 40;
        this.lineCycle += 40;
      }
    }
    return stolen;
  }
}

export class Cia {
  pra = 0xff; prb = 0xff; ddra = 0; ddrb = 0;
  ta = 0xffff; tb = 0xffff; tal = 0xffff; tbl = 0xffff;
  cra = 0; crb = 0;
  icr = 0; mask = 0;
  sdr = 0;
  /**
   * cycles a timer does not count yet: one started or loaded by a write waits for the rest of the writing
   * instruction, and starts one cycle later still; its interrupt follows the underflow a cycle after that
   */
  waitA = 0; waitB = 0;
  /** a write just started or loaded the timer (the C64 sets the wait, as it knows the instruction) */
  startedA = false; startedB = false;
  /** TOD: tenths, seconds, minutes, hours (BCD) */
  readonly tod = new Uint8Array([0, 0, 0, 1]);
  private todCycles = 0;
  /** the levels of the port pins the outside world drives (keyboard, joysticks, serial bus) */
  inputA: () => number = () => 0xff;
  inputB: () => number = () => 0xff;

  get irq(): boolean { return (this.icr & this.mask & 0x1f) !== 0; }

  advance(n: number): void {
    let underflowsA = 0;
    const nb = n - Math.min(n, this.waitB);
    this.waitB -= n - nb;
    if (this.cra & 1 && !(this.cra & 0x20)) {
      const na = n - Math.min(n, this.waitA);
      this.waitA -= n - na;
      this.ta -= na;
      while (this.ta < 0) {
        underflowsA++;
        this.icr |= 1;
        if (this.cra & 8) { this.cra &= ~1; this.ta = this.tal; break; }
        this.ta += this.tal + 1;
      }
    }
    if (this.crb & 1) {
      const mode = (this.crb >> 5) & 3;
      const count = mode === 0 ? nb : mode >= 2 ? underflowsA : 0;
      if (count) {
        this.tb -= count;
        while (this.tb < 0) {
          this.icr |= 2;
          if (this.crb & 8) { this.crb &= ~1; this.tb = this.tbl; break; }
          this.tb += this.tbl + 1;
        }
      }
    }
    this.todCycles += n;
    if (this.todCycles >= CLOCK / 10) { this.todCycles -= CLOCK / 10; this.tickTod(); }
  }

  private tickTod(): void {
    const t = this.tod;
    const inc = (v: number) => (v & 15) === 9 ? (v & 0xf0) + 0x10 : v + 1;
    if ((t[0] = (t[0] + 1) % 10) !== 0) return;
    t[1] = t[1] === 0x59 ? 0 : inc(t[1]);
    if (t[1]) return;
    t[2] = t[2] === 0x59 ? 0 : inc(t[2]);
    if (t[2]) return;
    const pm = t[3] & 0x80, h = t[3] & 0x1f;
    t[3] = h === 0x11 ? 0x12 | (pm ^ 0x80) : h === 0x12 ? 0x01 | pm : inc(h) | pm;
  }

  read(r: number): number {
    switch (r) {
      case 0x0: return (this.pra | ~this.ddra) & this.inputA() & 0xff;
      case 0x1: return (this.prb | ~this.ddrb) & this.inputB() & 0xff;
      case 0x2: return this.ddra;
      case 0x3: return this.ddrb;
      case 0x4: return Math.max(this.ta, 0) & 0xff;
      case 0x5: return Math.max(this.ta, 0) >> 8;
      case 0x6: return Math.max(this.tb, 0) & 0xff;
      case 0x7: return Math.max(this.tb, 0) >> 8;
      case 0x8: return this.tod[0];
      case 0x9: return this.tod[1];
      case 0xa: return this.tod[2];
      case 0xb: return this.tod[3];
      case 0xc: return this.sdr;
      case 0xd: { const v = this.icr | (this.irq ? 0x80 : 0); this.icr = 0; return v; }
      case 0xe: return this.cra & 0xef;
      default: return this.crb & 0xef;
    }
  }

  write(r: number, v: number): void {
    switch (r) {
      case 0x0: this.pra = v; return;
      case 0x1: this.prb = v; return;
      case 0x2: this.ddra = v; return;
      case 0x3: this.ddrb = v; return;
      case 0x4: this.tal = (this.tal & 0xff00) | v; return;
      case 0x5: this.tal = (this.tal & 0xff) | (v << 8); if (!(this.cra & 1)) this.ta = this.tal; return;
      case 0x6: this.tbl = (this.tbl & 0xff00) | v; return;
      case 0x7: this.tbl = (this.tbl & 0xff) | (v << 8); if (!(this.crb & 1)) this.tb = this.tbl; return;
      case 0x8: case 0x9: case 0xa: case 0xb: if (!(this.crb & 0x80)) this.tod[r - 8] = v; return;
      case 0xc: this.sdr = v; return;
      case 0xd: if (v & 0x80) this.mask |= v & 0x1f; else this.mask &= ~v & 0x1f; return;
      case 0xe: if (v & 0x10) this.ta = this.tal; this.startedA = (v & 0x10) !== 0 || ((v & 1) !== 0 && !(this.cra & 1)); this.cra = v & 0xef; return;
      default: if (v & 0x10) this.tb = this.tbl; this.startedB = (v & 0x10) !== 0 || ((v & 1) !== 0 && !(this.crb & 1)); this.crb = v & 0xef;
    }
  }
}

/** The keys held down (by keyboard matrix column, a bit per row) and the joysticks (bit 4 = fire). */
export class Input {
  readonly keys = new Uint8Array(8);
  joy1 = 0;
  joy2 = 0;
  /** the PETSCII code of the key held down, for the stand-in GETIN */
  petscii = 0;
  release(): void { this.keys.fill(0); this.joy1 = this.joy2 = 0; this.petscii = 0; }
}

export interface Roms {
  basic: Uint8Array; kernal: Uint8Array; chargen: Uint8Array;
  /** where they came from */
  source: string;
  /** the 1541's DOS ROM (16 KB), for a disk, and where it came from */
  drive?: Uint8Array;
  driveSource?: string;
}

/** The machine state that can be saved and put back (the post-boot state is reused between files). */
export interface MachineState {
  ram: Uint8Array; color: Uint8Array; ddr: number; port: number;
  cpu: { a: number; x: number; y: number; s: number; pc: number; p: number };
  vic: { regs: Uint8Array; line: number; lineCycle: number; compare: number; flags: number };
  cia: [Cia, Cia];
  cycles: number;
}

export class C64 implements Bus {
  readonly ram = new Uint8Array(0x10000);
  readonly color = new Uint8Array(0x400);
  readonly map = new Uint8Array(256);
  basic: Uint8Array;
  kernal: Uint8Array;
  chargen: Uint8Array;
  ddr = 0x2f;
  port = 0x37;
  readonly vic = new Vic();
  readonly cia1 = new Cia();
  readonly cia2 = new Cia();
  readonly sidRegs = new Uint8Array(0x20);
  readonly input = new Input();
  readonly cpu: Cpu;
  cycles = 0;
  /** the 1541 on the serial bus, and the C64 and drive cycles when it was attached */
  drive: Drive | null = null;
  private driveBase = 0;
  private driveStart = 0;

  // --- tracking ---------------------------------------------------------------------------------------------------
  /** the layer that wrote each RAM byte last (BOOT, LOADED or a layer id) */
  readonly wid = new Int32Array(0x10000).fill(BOOT);
  /** when it was written last (an instruction count, 0 = never) */
  readonly wtime = new Uint32Array(0x10000);
  /** when it was last read as data */
  readonly rtime = new Uint32Array(0x10000);
  /** when it was last executed (any byte of an instruction) */
  readonly etime = new Uint32Array(0x10000);
  /** the tag new writes get */
  tag = BOOT;
  /** the CPU runs ROM code (or C64 set-up code in RAM): its writes below $0400 are the system's (keyboard buffer,
   * clock, screen editor), not the program's */
  inRom = true;
  /** instructions executed (from 1) */
  icount = 1;
  /**
   * Writes (from $0400) to addresses not written since `freshMark` (an instruction count), next to the one before:
   * a depacker streaming its output through memory makes many, a program rewriting its screen and variables (or
   * now and then a variable it had not touched for a while) next to none. Sindri tells progress from settling
   * with it.
   */
  fresh = 0;
  freshMark = 0;
  private lastFresh = -2;
  /** writes to I/O registers since the counter was reset (VIC, SID, CIA), for telling programs from depackers */
  ioWrites = 0;

  private noise = 0x7e1d;
  private fade = 0;
  private fadeUntil = 0;

  constructor(roms: Roms) {
    this.basic = roms.basic; this.kernal = roms.kernal; this.chargen = roms.chargen;
    this.cpu = new Cpu(this);
    this.cia1.inputA = () => ~this.input.joy2 & 0xff;
    this.cia1.inputB = () => {
      const cols = ~(this.cia1.pra | ~this.cia1.ddra) & 0xff;
      let rows = 0xff;
      for (let c = 0; c < 8; c++) if (cols & (1 << c)) rows &= ~this.input.keys[c];
      return rows & ~this.input.joy1 & 0xff;
    };
    // serial bus: CLK IN and DATA IN are low while either side pulls them; with no drive only the C64's own
    // (inverted) outputs do
    this.cia2.inputA = () => {
      const d = this.drive;
      if (d) return 0x3f | (d.clkLow ? 0 : 0x40) | (d.dataLow ? 0 : 0x80);
      return 0x3f | (this.cia2.pra & 0x10 ? 0 : 0x40) | (this.cia2.pra & 0x20 ? 0 : 0x80);
    };
    this.updateMap();
  }

  // --- the serial bus -------------------------------------------------------------------------------------------
  /** Put a 1541 on the serial bus; it runs from now on, behind the C64. */
  attachDrive(d: Drive): void {
    this.drive = d;
    this.driveBase = this.cycles;
    this.driveStart = d.cycles;
    this.serialOut();
  }

  /** Let the drive catch up to C64 cycle `at`. */
  syncDrive(at = this.cycles): void {
    this.drive?.runUntil(this.driveStart + (at - this.driveBase) * DRIVE_RATIO);
  }

  /** the C64's ATN, CLK and DATA outputs (bits 3-5 of $dd00, through inverters: a 1 pulls the line low) */
  private serialOut(): void {
    const out = this.cia2.pra | ~this.cia2.ddra;
    this.drive!.setC64((out & 0x08) !== 0, (out & 0x10) !== 0, (out & 0x20) !== 0);
  }

  /** the cycle in which the running instruction reaches the bus: its last one */
  private get busCycle(): number { return this.cycles + CYCLES[this.cpu.lastOp & 0xff] - 1; }

  // --- banking ----------------------------------------------------------------------------------------------------
  updateMap(): void {
    const m = (this.port | ~this.ddr) & 7;
    const map = this.map;
    map.fill(RAM);
    map[0] = ZP;
    const basic = (m & 3) === 3 ? BASIC : RAM;
    for (let p = 0xa0; p < 0xc0; p++) map[p] = basic;
    const d = (m & 3) === 0 ? RAM : m & 4 ? IO : CHAR;
    for (let p = 0xd0; p < 0xe0; p++) map[p] = d;
    const kernal = m & 2 ? KERNAL : RAM;
    for (let p = 0xe0; p < 0x100; p++) map[p] = kernal;
  }

  /** the processor port as read at $01: pull-ups on bits 0-2, no cassette button on bit 4, bits 6-7 fade */
  private readPort(): number {
    let inputs = 0x17;
    if (this.cycles < this.fadeUntil) inputs |= this.fade;
    return ((this.port & this.ddr) | (~this.ddr & inputs)) & 0xff;
  }

  private writePort(a: number, v: number): void {
    if (a === 0) {
      // bits 6-7 switched to input keep their level for a while
      const off = this.ddr & ~v & 0xc0;
      if (off) { this.fade = (this.fade & ~off) | (this.port & off); this.fadeUntil = this.cycles + 350000; }
      this.ddr = v;
    } else this.port = v;
    this.updateMap();
  }

  /** the value at $01 as a program sees it */
  get cpuPort(): number { return this.readPort(); }

  // --- the bus ----------------------------------------------------------------------------------------------------
  read(a: number): number {
    switch (this.map[a >> 8]) {
      case RAM:
        // (the system reading its own variables below $0400, as the KERNAL's interrupt does, is not the program's)
        if (!this.inRom || a >= 0x400) this.rtime[a] = this.icount;
        return this.ram[a];
      case ZP:
        if (a === 0) return this.ddr;
        if (a === 1) return this.readPort();
        if (!this.inRom) this.rtime[a] = this.icount;
        return this.ram[a];
      case BASIC: return this.basic[a - 0xa000];
      case KERNAL: return this.kernal[a - 0xe000];
      case CHAR: return this.chargen[a - 0xd000];
      default: return this.readIo(a);
    }
  }

  fetch(a: number): number {
    switch (this.map[a >> 8]) {
      case RAM: case ZP: return a > 1 ? this.ram[a] : a === 0 ? this.ddr : this.readPort();
      case BASIC: return this.basic[a - 0xa000];
      case KERNAL: return this.kernal[a - 0xe000];
      case CHAR: return this.chargen[a - 0xd000];
      default: return this.readIo(a);
    }
  }

  write(a: number, v: number): void {
    if (this.map[a >> 8] === IO) { this.writeIo(a, v); return; }
    if (a < 2) this.writePort(a, v);
    if (a >= 0x400 && this.wtime[a] < this.freshMark) {
      if (a - this.lastFresh === 1 || this.lastFresh - a === 1) this.fresh++;
      this.lastFresh = a;
    }
    this.wid[a] = this.inRom && a < 0x400 ? BOOT : this.tag;
    this.wtime[a] = this.icount;
    this.ram[a] = v;
  }

  /** what the CPU would read, without side effects (for reports and traps) */
  peek(a: number): number {
    switch (this.map[a >> 8]) {
      case BASIC: return this.basic[a - 0xa000];
      case KERNAL: return this.kernal[a - 0xe000];
      case CHAR: return this.chargen[a - 0xd000];
      case IO: return a >= 0xd800 && a < 0xdc00 ? this.color[a & 0x3ff] : 0;
      default: return a > 1 ? this.ram[a] : a === 0 ? this.ddr : this.readPort();
    }
  }

  peekWord(a: number): number { return this.peek(a) | (this.peek((a + 1) & 0xffff) << 8); }

  private readIo(a: number): number {
    if (a < 0xd400) return this.vic.read(a & 0x3f);
    if (a < 0xd800) return this.readSid(a & 0x1f);
    if (a < 0xdc00) return this.color[a & 0x3ff] & 0x0f;
    if (a < 0xdd00) return this.cia1.read(a & 0x0f);
    if (a < 0xde00) {
      // ($dd00 and $dd02, the serial port and its data direction: the drive catches up first)
      if (this.drive && (a & 0x0d) === 0) this.syncDrive(this.busCycle);
      return this.cia2.read(a & 0x0f);
    }
    return 0;
  }

  private writeIo(a: number, v: number): void {
    this.ioWrites++;
    if (a < 0xd400) this.vic.write(a & 0x3f, v);
    else if (a < 0xd800) this.sidRegs[a & 0x1f] = v;
    else if (a < 0xdc00) this.color[a & 0x3ff] = v & 0x0f;
    else if (a < 0xdd00) { this.cia1.write(a & 0x0f, v); this.timerStart(this.cia1); }
    else if (a < 0xde00) {
      const serial = this.drive && (a & 0x0d) === 0;
      if (serial) this.syncDrive(this.busCycle);
      this.cia2.write(a & 0x0f, v);
      this.timerStart(this.cia2);
      if (serial) this.serialOut();
    }
  }

  /** a timer the write started waits for the rest of this instruction (see Cia.waitA) */
  private timerStart(cia: Cia): void {
    const wait = CYCLES[this.cpu.lastOp & 0xff] + 2;
    if (cia.startedA) { cia.waitA = wait; cia.startedA = false; }
    if (cia.startedB) { cia.waitB = wait; cia.startedB = false; }
  }

  private readSid(r: number): number {
    switch (r) {
      case 0x19: case 0x1a: return 0xff;
      case 0x1b: {
        // oscillator 3 as noise: a 23-bit LFSR, stepped by the time that passed
        for (let k = (this.cycles & 7) + 1; k > 0; k--) {
          const bit = ((this.noise >> 22) ^ (this.noise >> 17)) & 1;
          this.noise = ((this.noise << 1) | bit) & 0x7fffff;
        }
        return (this.noise >> 15) & 0xff;
      }
      default: return 0;
    }
  }

  // --- time and interrupts ----------------------------------------------------------------------------------------
  /** Let the cycles of one instruction pass; returns them plus the cycles badlines stole. */
  advance(n: number): number {
    const total = n + this.vic.advance(n);
    this.cia1.advance(total);
    this.cia2.advance(total);
    this.cycles += total;
    return total;
  }

  get irqLine(): boolean { return this.vic.irq || this.cia1.irq; }
  get nmiLine(): boolean { return this.cia2.irq; }

  // --- state ------------------------------------------------------------------------------------------------------
  save(): MachineState {
    const c = this.cpu;
    const copyCia = (s: Cia) => Object.assign(Object.create(Cia.prototype) as Cia, s, { tod: s.tod.slice() });
    return {
      ram: this.ram.slice(), color: this.color.slice(), ddr: this.ddr, port: this.port,
      cpu: { a: c.a, x: c.x, y: c.y, s: c.s, pc: c.pc, p: c.p },
      vic: { regs: this.vic.regs.slice(), line: this.vic.line, lineCycle: this.vic.lineCycle, compare: this.vic.compare, flags: this.vic.flags },
      cia: [copyCia(this.cia1), copyCia(this.cia2)],
      cycles: this.cycles,
    };
  }

  restore(s: MachineState): void {
    this.ram.set(s.ram); this.color.set(s.color); this.ddr = s.ddr; this.port = s.port;
    const c = this.cpu;
    c.a = s.cpu.a; c.x = s.cpu.x; c.y = s.cpu.y; c.s = s.cpu.s; c.pc = s.cpu.pc; c.p = s.cpu.p;
    this.vic.regs.set(s.vic.regs); this.vic.line = s.vic.line; this.vic.lineCycle = s.vic.lineCycle;
    this.vic.compare = s.vic.compare; this.vic.flags = s.vic.flags;
    for (const [mine, saved] of [[this.cia1, s.cia[0]], [this.cia2, s.cia[1]]] as const) {
      const { inputA, inputB } = mine;
      Object.assign(mine, saved, { tod: saved.tod.slice(), inputA, inputB });
    }
    this.cycles = s.cycles;
    this.updateMap();
  }
}
