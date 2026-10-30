/* Sindri: it starts a C64 (or the stand-ins), loads the packed PRG, types RUN, and follows the program as
 * it peels off its layers.
 *
 * A layer begins when the CPU jumps (JMP, JSR, RTS, RTI, BRK or an interrupt) into code that the running layer
 * wrote and has not run yet: a depacker that copied itself to $0100, the program it decrunched, the code a decoder
 * decrypted. Jumping into BASIC's RUN counts too. Memory is copied at each layer's start, with the bytes that belong
 * to the program it starts. Layers begun inside a subroutine call or an interrupt that then returns to where it was
 * called from were temporary (a depacker called with JSR, generated speedcode, a new IRQ handler): they join the
 * layer that made the call again.
 *
 * The run stops when the newest layer settles (writes no new memory for a while), loads a file, returns to BASIC,
 * crashes or runs out of time. With a disk, a 1541 is on the serial bus and loading goes on: the KERNAL's and fast
 * loaders' alike. Then the newest layer is the unpacked program. An intro that waits before anything
 * was unpacked gets keys pressed (space and fire first). */
import { BASIC, BOOT, C64, KERNAL, LOADED, ZP, type MachineState, type Roms } from './c64.ts';
import { OP_IRQ, OP_NMI } from './cpu.ts';
import { LEN } from './opcodes.ts';
import { initStandIn, KERNAL_VECTORS, standInRoms } from './standin.ts';
import { activity, fingerprintId, identify, strings, type Activity, type Kind, type Range } from './analyze.ts';
import { buildPrg, contentMask, saveRange } from './output.ts';
import { Drive, type DriveState } from './drive.ts';
import { d64ToDisk } from './gcr.ts';
import { basicLines, evaluate, findSys, listLine, statements, T } from './basic.ts';

export interface UnpackOptions {
  /** the C64 ROMs; without them the stand-ins run (fine for most packers, but not for BASIC programs) */
  roms?: Roms | null;
  /**
   * the disk the file came from (a D64 image): with the 1541 DOS ROM in `roms` a 1541 with this disk is on the
   * serial bus, so the program can load more files and run its fast loader
   */
  disk?: Uint8Array | null;
  /** start the program here (SYS) instead of RUN */
  entry?: number;
  /** load the file here instead of at its own load address */
  load?: number;
  /** give up after this many cycles of the program (default 400 million, about 7 minutes of C64 time) */
  maxCycles?: number;
  /** a layer has settled when it writes no new memory for this many cycles (default 1.5 million) */
  settleCycles?: number;
  /** press keys and fire when an intro waits before anything is unpacked (default true) */
  keys?: boolean;
  /** press keys whenever a layer waits, and keep going (past intros after the decrunching) */
  deep?: boolean;
  /** save this layer instead of the newest */
  layer?: number;
  /** clear the bytes in the saved range that are not part of the program (leftovers) */
  clean?: boolean;
  /** a line for every layer and every key press */
  trace?: (line: string) => void;
  /** called before every instruction once the program has started (slow; for looking into a packer) */
  onStep?: (pc: number, c64: C64) => void;
}

export type Via = 'start' | 'jmp' | 'jsr' | 'rts' | 'rti' | 'brk' | 'irq' | 'nmi';

export type StopReason =
  | 'settled' | 'ready' | 'load' | 'save' | 'jam' | 'needs-rom' | 'budget' | 'reset' | 'brk' | 'not-started';

export interface LayerReport {
  index: number;
  /** where it starts */
  entry: number;
  /** how it was entered, and from where */
  via: Via;
  from: number | null;
  /** the C64 time it started, in cycles after the program started */
  cycle: number;
  /** it is a BASIC program started with RUN (entry is then the BASIC routine jumped to) */
  basic: boolean;
  kind: Kind;
  code: Range[];
  instructions: number;
  written: Range[];
  writtenBytes: number;
  read: Range[];
  readBytes: number;
  /** code it wrote and called as a subroutine or interrupt handler */
  calls: { entry: number; via: Via }[];
  /** the fingerprint of its code, and the packer it matches */
  fingerprint: string;
  opcodes: string;
  packer: { name: string; similarity: number } | null;
  /** readable text in and around its code */
  text: string[];
  /** what it printed with CHROUT */
  printed: string;
  /** the keys pressed while it ran */
  presses: string[];
  /** the range that would be saved for it */
  range: Range | null;
}

export interface Saved {
  layer: number;
  /** the PRG, load address first */
  prg: Uint8Array;
  start: number;
  end: number;
  /** where to start it: the SYS address (for a BASIC program the first line's SYS, else its start) */
  entry: number;
  /** started with RUN */
  basic: boolean;
  /** $01 as the program found it */
  port: number;
  /** interrupts were on (the I flag clear) */
  interrupts: boolean;
}

export interface UnpackResult {
  /** a layer was peeled off */
  unpacked: boolean;
  stop: { reason: StopReason; pc: number; detail: string; cycle: number };
  /** the layers in order: 0 is the loaded program */
  layers: LayerReport[];
  /** the saved layer (the newest, or options.layer) */
  saved: Saved | null;
  /** build the PRG of another layer */
  save(layer: number, clean?: boolean): Saved | null;
  /** the loaded file's BASIC lines, when it has some */
  basic: string[];
  roms: string;
  /** the 1541 on the serial bus and its disk, or why there was none; null without a disk */
  drive: string | null;
  /** emulated cycles from the program's start */
  cycles: number;
  ms: number;
}

interface Snapshot { ram: Uint8Array; port: number; a: number; x: number; y: number; s: number; p: number }
interface Trap { rom: number; run: () => boolean }
/** boot to READY, LOAD typed, file loaded, RUN typed (the stand-ins start in 'run') */
type Phase = 'boot' | 'load' | 'loaded' | 'run';

class Layer {
  id: number;
  parent: Layer | null;
  entry: number;
  via: Via;
  from: number | null;
  cycle: number;
  icount: number;
  basic = false;
  snapshot: Snapshot;
  mask: Uint8Array | null = null;
  activity: Activity | null = null;
  calls: { entry: number; via: Via }[] = [];
  printed = '';
  presses: string[] = [];
  constructor(id: number, parent: Layer | null, entry: number, via: Via, from: number | null, cycle: number, icount: number, snapshot: Snapshot) {
    this.id = id; this.parent = parent; this.entry = entry; this.via = via; this.from = from;
    this.cycle = cycle; this.icount = icount; this.snapshot = snapshot;
  }
}

/** BASIC's ways into RUN and READY: a depacker jumping here starts a BASIC program */
const BASIC_ENTRIES = [0xa7ae, 0xa871, 0xa659, 0xa660, 0xa68e, 0xa533, 0xa474, 0xa480, 0xa483, 0xe37b, 0xe386];
const TRANSFER = new Uint8Array(0x102);
for (const op of [0x4c, 0x6c, 0x20, 0x60, 0x40, 0x00, OP_IRQ, OP_NMI]) TRANSFER[op] = 1;
const VIA: Record<number, Via> = { 0x4c: 'jmp', 0x6c: 'jmp', 0x20: 'jsr', 0x60: 'rts', 0x40: 'rti', 0x00: 'brk', [OP_IRQ]: 'irq', [OP_NMI]: 'nmi' };

/** the keys tried, in turn, on an intro that waits: [matrix column, row] */
const PRESSES: { name: string; keys: [number, number][]; joy: number; petscii: number }[] = [
  { name: 'space + fire', keys: [[7, 4]], joy: 0x10, petscii: 0x20 },
  { name: 'return', keys: [[0, 1]], joy: 0, petscii: 0x0d },
  { name: 'n', keys: [[4, 7]], joy: 0, petscii: 0x4e },
  { name: 'f1', keys: [[0, 4]], joy: 0, petscii: 0x85 },
  { name: 'y', keys: [[3, 1]], joy: 0, petscii: 0x59 },
  { name: 'f7', keys: [[0, 3]], joy: 0, petscii: 0x88 },
  { name: '1', keys: [[7, 0]], joy: 0, petscii: 0x31 },
];
const MAX_PRESSES = 24;
const HOLD = 100_000;
const CHECK = 4096;
const CALLS = 1024;
/** the stand-in SYS pushes this, so RTS lands on the trap at $e147 */
const SYS_RETURN = 0xe146;

const hex4 = (v: number) => '$' + v.toString(16).padStart(4, '0');

const bootCache = new Map<string, MachineState>();
/** the 1541 after it started up (by its ROM): it has long been on when a real C64 loads the file */
const driveCache = new Map<string, DriveState>();
const DRIVE_BOOT = 2_500_000;
/** a program waiting while the drive's motor runs is loading, not settled: for this long at most (10 s) */
const DRIVE_PATIENCE = 10_000_000;

/** Unpack a PRG (load address first). */
export function unpack(file: Uint8Array, options: UnpackOptions = {}): UnpackResult {
  return new Session(file, options).run();
}

class Session {
  readonly m: C64;
  readonly real: boolean;
  readonly o: UnpackOptions;
  /** the layer that last executed each instruction start */
  readonly eid = new Int32Array(0x10000).fill(-3);
  private readonly special = new Uint8Array(0x10000);
  private readonly traps = new Map<number, Trap>();
  private readonly loadAt: number;
  private readonly data: Uint8Array;
  private readonly file: Uint8Array;
  private readonly maxCycles: number;
  private readonly settleCycles: number;

  layers: Layer[] = [];
  private cur: Layer | null = null;
  private curId = BOOT;
  private nextId = 0;
  private started = false;
  /** the open subroutine calls and interrupts: stack pointer, return address, layers when called */
  private readonly callSp = new Int16Array(CALLS);
  private readonly callRet = new Int32Array(CALLS);
  private readonly callLayers = new Int32Array(CALLS);
  private calls = 0;
  /** the stack pointer of the innermost open call (above any value while there is none) */
  private frameSp = 0x1ff;
  private lastRam = false;
  private lastPc = 0;
  private irqRet = 0;
  /** where the last RTS at a call's own stack level was due to return (for data after a JSR) */
  private skipFrom = -1;
  private skipAt = -1;
  private irqOp = -1;
  private irqFrom = 0;
  private nmiWas = false;
  private startCycle = 0;

  private phase: Phase = 'boot';
  private phaseAt = 0;
  private triedSys = false;
  private stopped = false;
  private stopInfo: UnpackResult['stop'] = { reason: 'settled', pc: 0, detail: '', cycle: 0 };

  private progressLayer: Layer | null = null;
  private progressAt = 0;
  /** the current window of the progress measure, and the fresh writes of all windows so far */
  private windowEnd = 0;
  private windowIcount = 0;
  private freshSum = 0;
  private holdUntil = 0;
  private pressIndex = 0;
  private pressCount = 0;
  private pressMark: { layer: Layer | null; fresh: number } | null = null;

  /** the stand-in BASIC interpreter: the statements of the program and the next one to run */
  private basicStatements: number[][] = [];
  private basicPos = 0;
  private basicRunning = false;
  /** the 1541 (with a disk and its DOS ROM), or why there is none */
  private drive: Drive | null = null;
  private driveNote: string | null = null;
  /** since when the drive's motor runs without the program getting new data */
  private driveBusy = 0;

  constructor(file: Uint8Array, o: UnpackOptions) {
    if (file.length < 3) throw new Error('not a PRG: shorter than 3 bytes');
    this.o = o;
    this.file = file;
    this.real = !!o.roms;
    this.m = new C64(o.roms ?? standInRoms());
    this.loadAt = o.load ?? (file[0] | (file[1] << 8));
    this.data = file.subarray(2, 2 + Math.min(file.length - 2, 0x10000 - this.loadAt));
    this.maxCycles = o.maxCycles ?? 400_000_000;
    this.settleCycles = o.settleCycles ?? 1_500_000;
    for (const a of BASIC_ENTRIES) this.special[a] |= 2;
    this.setupTraps();
  }

  // --- starting -----------------------------------------------------------------------------------------------------

  run(): UnpackResult {
    const t0 = performance.now();
    if (this.real) this.bootReal(); else this.bootStandIn();
    if (this.o.disk) this.attachDrive();
    if (!this.stopped) this.loop();
    return this.finish(performance.now() - t0);
  }

  private bootReal(): void {
    const m = this.m;
    const key = `${this.o.roms!.source}:${checksum(m.kernal)}:${checksum(m.basic)}`;
    const cached = bootCache.get(key);
    if (cached) {
      m.restore(cached);
      this.typeLine('LOAD');
      this.setPhase('load');
      return;
    }
    // power on: the port is all inputs (every ROM visible), SP = $fd after the reset sequence
    m.ddr = 0; m.port = 0; m.updateMap();
    m.cpu.s = 0xfd; m.cpu.p = 0x24;
    m.cpu.pc = m.peekWord(0xfffc);
    this.bootKey = key;
    this.setPhase('boot');
  }
  private bootKey = '';

  /** A 1541 with the disk on the serial bus, started up a while ago (it needs the real ROMs and its DOS ROM). */
  private attachDrive(): void {
    const rom = this.o.roms?.drive;
    if (!this.real) { this.driveNote = 'the stand-ins have no serial bus: the disk was not used'; return; }
    if (!rom) { this.driveNote = 'no 1541 DOS ROM: the disk was not used'; return; }
    const disk = d64ToDisk(this.o.disk!);
    const d = new Drive(rom), key = checksum(rom);
    const booted = driveCache.get(key);
    if (booted) d.restore(booted);
    else {
      while (d.cycles < DRIVE_BOOT) d.step();
      driveCache.set(key, d.save());
    }
    d.insert(disk);
    this.drive = d;
    this.m.attachDrive(d);
    this.driveNote = `1541 with "${disk.name}" ${disk.id}`;
  }

  private bootStandIn(): void {
    const m = this.m;
    initStandIn(m);
    this.loadFile();
    const end = this.loadAt + this.data.length;
    if (this.loadAt === 0x0801) for (const p of [0x2d, 0x2f, 0x31]) { m.ram[p] = end & 0xff; m.ram[p + 1] = end >> 8; }
    m.cpu.s = 0xf8;
    m.cpu.p = 0x20;
    this.setPhase('run');
    if (this.o.entry != null) { this.sys(this.o.entry); return; }
    const auto = this.autostart();
    if (auto != null) { m.cpu.pc = auto; m.cpu.lastOp = 0x6c; return; }
    if (this.loadAt === 0x0801) { this.runBasic(true); return; }
    this.sys(this.loadAt);
  }

  /** With the stand-ins: where a file that loads over the RAM vectors or the stack starts by itself. */
  private autostart(): number | null {
    const m = this.m, lo = this.loadAt, hi = this.loadAt + this.data.length;
    const covers = (a: number) => a >= lo && a + 1 < hi;
    for (const v of [0x0326, 0x0302, 0x0300, 0x0328, 0x032a, 0x0324]) {
      if (!covers(v)) continue;
      const target = m.peekWord(v);
      const def = v >= 0x0314 ? KERNAL_VECTORS[(v - 0x0314) >> 1] : [0xe38b, 0xa483][(v - 0x0300) >> 1];
      if (target !== def) return target;
    }
    for (let sp = 0xf6; sp <= 0xfd; sp++) {
      const a = 0x0100 + sp + 1;
      if (!covers(a)) continue;
      const target = (m.peekWord(a) + 1) & 0xffff;
      if (target >= lo && target < hi) return target;
    }
    return null;
  }

  private setPhase(p: Phase): void { this.phase = p; this.phaseAt = this.progressAt = this.m.cycles; }

  /** Write the file into RAM, as LOAD does (the processor port at $00/$01 is left alone). */
  private loadFile(): void {
    const m = this.m;
    for (let i = 0; i < this.data.length; i++) {
      const a = this.loadAt + i;
      if (a < 2) continue;
      m.ram[a] = this.data[i];
      m.wid[a] = LOADED;
      m.wtime[a] = m.icount;
    }
    const end = this.loadAt + this.data.length;
    m.ram[0xae] = end & 0xff; m.ram[0xaf] = (end >> 8) & 0xff;
    m.ram[0x90] = 0x40;
  }

  /** Type a line into the keyboard buffer (10 characters at most, RETURN added). */
  private typeLine(text: string): void {
    const m = this.m, bytes = [...text].map(c => c.charCodeAt(0)).concat(0x0d).slice(0, 10);
    m.ram.set(bytes, 0x0277);
    m.ram[0xc6] = bytes.length;
  }

  /** the program's first instruction in RAM: the first layer begins */
  private start(pc: number): void {
    const m = this.m;
    this.started = true;
    this.phase = 'run';
    const root = new Layer(0, null, pc, 'start', null, m.cycles, m.icount, this.snapshot());
    this.layers = [root];
    this.cur = root; this.curId = 0;
    m.tag = 0;
    this.startCycle = m.cycles;
    this.progressAt = m.cycles;
    this.trace(`layer 0 starts at ${hex4(pc)}`);
  }

  // --- the run ------------------------------------------------------------------------------------------------------

  private loop(): void {
    const m = this.m, cpu = m.cpu, map = m.map, ram = m.ram, etime = m.etime, wid = m.wid, eid = this.eid, special = this.special;
    let next = m.icount + CHECK;
    while (!this.stopped) {
      if (cpu.s > this.frameSp) this.unwind();
      const pc = cpu.pc;
      if (special[pc] && this.specialAt(pc)) {
        this.lastRam = false;
        if (m.icount >= next) { next = m.icount + CHECK; this.check(); }
        continue;
      }
      if (map[pc >> 8] <= ZP && (this.started || wid[pc] !== BOOT)) {
        // (before the program starts, RAM code the C64 set up itself, such as BASIC's CHRGET, is not the program)
        if (!this.started) this.start(pc);
        if (eid[pc] !== this.curId) {
          if (wid[pc] === this.curId && TRANSFER[cpu.lastOp] && this.isTransfer(pc)) this.enter(pc, false);
          eid[pc] = this.curId;
        }
        const ic = m.icount;
        etime[pc] = ic;
        const len = LEN[ram[pc]];
        if (len > 1) { etime[(pc + 1) & 0xffff] = ic; if (len > 2) etime[(pc + 2) & 0xffff] = ic; }
        this.lastRam = true;
        m.inRom = false;
      } else { this.lastRam = false; m.inRom = true; }
      this.lastPc = pc;
      if (this.o.onStep && this.started) this.o.onStep(pc, m);
      const iWas = cpu.i;
      const cycles = cpu.step();
      m.icount++;
      if (cpu.jammed) { this.jam(pc); break; }
      m.advance(cycles);
      // (before an interrupt that may follow at once: an RTI from a handler that ran a whole frame is a return)
      if (cpu.s > this.frameSp) this.unwind();
      if (this.started) {
        const op = cpu.lastOp;
        if (op === 0x20) this.call((pc + 3) & 0xffff);
        else if (op === 0x00) this.call((pc + 2) & 0xffff);
      }
      if (m.irqLine && !(cpu.lastOp === 0x40 ? cpu.i : iWas)) { this.interrupted(pc); m.advance(cpu.irq()); this.call(this.irqRet); }
      const nmi = m.nmiLine;
      if (nmi && !this.nmiWas) { this.interrupted(pc); m.advance(cpu.nmi()); this.call(this.irqRet); }
      this.nmiWas = nmi;
      if (m.icount >= next) { next = m.icount + CHECK; this.check(); }
    }
  }

  /** A subroutine call or an interrupt that returns to `ret`: remember it, with the number of layers so far. */
  private call(ret: number): void {
    if (!this.started) return;
    const k = this.calls;
    if (k >= CALLS) return;
    this.callSp[k] = this.m.cpu.s;
    this.callRet[k] = ret;
    this.callLayers[k] = this.layers.length;
    this.calls = k + 1;
    this.frameSp = this.m.cpu.s;
  }

  /**
   * The stack rose above a call: when it returned where it was called from, the layers begun inside it were
   * temporary and join the caller's again; when the stack was just dropped, they stay.
   */
  private unwind(): void {
    const cpu = this.m.cpu;
    while (this.calls && cpu.s > this.callSp[this.calls - 1]) {
      const k = --this.calls;
      const returned = (cpu.lastOp === 0x60 || cpu.lastOp === 0x40) && cpu.pc === this.callRet[k];
      // an RTS at the call's own stack level, a little behind the call: the subroutine skipped data after the JSR
      if (cpu.lastOp === 0x60 && cpu.s === this.callSp[k] + 2) { this.skipFrom = this.callRet[k]; this.skipAt = this.m.icount; }
      if (returned && this.layers.length > this.callLayers[k]) this.merge(this.layers[this.callLayers[k]]);
    }
    this.frameSp = this.calls ? this.callSp[this.calls - 1] : 0x1ff;
  }

  /** An interrupt is taken after the instruction at `pc`: remember where it returns to, and how the CPU got there. */
  private interrupted(pc: number): void {
    const cpu = this.m.cpu;
    this.irqRet = cpu.pc;
    this.irqOp = TRANSFER[cpu.lastOp] ? cpu.lastOp : -1;
    this.irqFrom = pc;
  }

  /**
   * Whether the jump to `pc` (code the running layer wrote) starts a new layer. Not when an RTS returns behind a JSR
   * this layer ran (the subroutine changed the code there), nor when an RTI returns into the middle of the code it
   * interrupted; an RTI to the first instruction after a jump counts as that jump.
   */
  private isTransfer(pc: number): boolean {
    const op = this.m.cpu.lastOp;
    if (op === 0x60) {
      const j = (pc - 3) & 0xffff;
      if (this.m.ram[j] === 0x20 && this.eid[j] === this.curId) return false;
      if (this.skipAt === this.m.icount && pc >= this.skipFrom && pc - this.skipFrom < 0x200 && this.eid[(this.skipFrom - 3) & 0xffff] === this.curId) return false;
    }
    if (op === 0x40 && pc === this.irqRet) return this.irqOp >= 0;
    return true;
  }

  /** a trap or a BASIC entry at `pc`; true when a trap did the work (the instruction there is not run) */
  private specialAt(pc: number): boolean {
    const m = this.m, page = m.map[pc >> 8], flags = this.special[pc];
    if (flags & 2 && this.started && this.lastRam && TRANSFER[m.cpu.lastOp] && (page === BASIC || page === KERNAL)) this.enter(pc, true);
    if (flags & 1) {
      const t = this.traps.get(pc);
      if (t && t.rom === page) return t.run();
    }
    return false;
  }

  /** A new layer starts at `pc`. */
  private enter(pc: number, basic: boolean): void {
    const m = this.m, cpu = m.cpu, parent = this.cur!;
    parent.activity = activity(m, this.eid, parent.id, parent.icount);
    // a jump the CPU took just before an interrupt counts as made when the interrupt returns
    const late = cpu.lastOp === 0x40 && pc === this.irqRet && this.irqOp >= 0;
    const op = late ? this.irqOp : cpu.lastOp, from = late ? this.irqFrom : this.lastPc;
    const layer = new Layer(++this.nextId, parent, pc, VIA[op] ?? 'jmp', from, m.cycles, m.icount, this.snapshot());
    layer.basic = basic;
    const kinds = new Map(this.layers.filter(l => l.activity).map(l => [l.id, l.activity!.kind]));
    layer.mask = contentMask(m, parent.id, parent.snapshot.ram, kinds);
    this.layers.push(layer);
    this.cur = layer; this.curId = layer.id;
    m.tag = layer.id;
    this.trace(`${layer.via} ${basic ? 'into BASIC ' : ''}from ${hex4(from)} to ${hex4(pc)}: layer ${this.layers.length - 1} (${parent.activity.kind} before it, ${this.calls} open calls, sp $${this.m.cpu.s.toString(16)})`);
  }

  /** Layer L returned to the layer that called it: it and the layers after it join that one again. */
  private merge(L: Layer): void {
    const m = this.m, P = L.parent!, gone = this.layers.splice(this.layers.indexOf(L));
    const { wid } = m, eid = this.eid;
    for (let a = 0; a < 0x10000; a++) {
      if (wid[a] >= L.id) wid[a] = P.id;
      if (eid[a] >= L.id) eid[a] = P.id;
    }
    for (const g of gone) {
      if (P.calls.length < 16) P.calls.push({ entry: g.entry, via: g.via });
      P.printed += g.printed;
      P.presses.push(...g.presses);
    }
    this.cur = P; this.curId = P.id;
    m.tag = P.id;
    P.activity = null;
    this.trace(`returned to ${hex4(m.cpu.pc)}: ${gone.map(g => hex4(g.entry)).join(', ')} ran in a call from layer ${this.layers.length - 1}`);
  }

  private check(): void {
    const m = this.m, now = m.cycles;
    if (!this.started) {
      if (this.phase !== 'run' && now - this.phaseAt > 20_000_000) { this.stop('not-started', `the C64 did not get through ${this.phase}`); return; }
    } else if (now - this.startCycle > this.maxCycles) { this.stop('budget', `still running after ${(this.maxCycles / 985248).toFixed(0)} s of C64 time`); return; }
    if (this.holdUntil && now >= this.holdUntil) { m.input.release(); this.holdUntil = 0; this.progressAt = now; }
    m.syncDrive();
    if (this.phase !== 'run') return;
    if (now >= this.windowEnd) {
      // a window is a third of the settle time; fresh writes in it, or a new layer, are progress
      if (m.fresh >= 128 || this.cur !== this.progressLayer) { this.progressLayer = this.cur; this.progressAt = now; this.driveBusy = 0; }
      this.freshSum += m.fresh;
      m.fresh = 0;
      m.freshMark = this.windowIcount;
      this.windowIcount = m.icount;
      this.windowEnd = now + this.settleCycles / 3;
    }
    if (this.drive?.motorOn) {
      if (!this.driveBusy) this.driveBusy = now;
      if (now - this.driveBusy < DRIVE_PATIENCE) this.progressAt = now;
    } else this.driveBusy = 0;
    if (!this.holdUntil && now - this.progressAt >= this.settleCycles) this.settled();
  }

  /** The program writes no new memory: press a key if it is an intro still in front of the depacker, or stop. */
  private settled(): void {
    const m = this.m;
    const first = !this.started || this.layers.length === 1;
    if (this.pressMark) {
      const reacted = this.cur !== this.pressMark.layer || this.freshSum + m.fresh - this.pressMark.fresh >= 128;
      if (reacted) this.pressIndex = 0;
    }
    if ((first || this.o.deep) && this.o.keys !== false && this.pressCount < MAX_PRESSES) {
      const p = PRESSES[this.pressIndex];
      if (p) {
        this.pressIndex++;
        this.pressCount++;
        m.input.release();
        for (const [col, row] of p.keys) m.input.keys[col] |= 1 << row;
        m.input.joy1 = m.input.joy2 = p.joy;
        m.input.petscii = p.petscii;
        this.holdUntil = m.cycles + HOLD;
        this.pressMark = { layer: this.cur, fresh: this.freshSum + m.fresh };
        const when = ((m.cycles - this.startCycle) / 985248).toFixed(1);
        this.cur?.presses.push(`${p.name} at ${when} s`);
        this.trace(`waiting at ${hex4(m.cpu.pc)}: pressed ${p.name}`);
        return;
      }
    }
    if (!this.started) { this.stop('not-started', 'no machine code ran'); return; }
    this.stop('settled', `waits at ${hex4(m.cpu.pc)}`);
  }

  private stop(reason: StopReason, detail = ''): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopInfo = { reason, pc: this.m.cpu.pc, detail, cycle: this.started ? this.m.cycles - this.startCycle : 0 };
    this.trace(`stopped: ${reason}${detail ? ` (${detail})` : ''}`);
  }

  private jam(pc: number): void {
    const page = this.m.map[pc >> 8];
    if (!this.real && (page === BASIC || page === KERNAL)) this.stop('needs-rom', `calls the ROM at ${hex4(pc)}, which the stand-ins do not have`);
    else this.stop('jam', `the CPU stopped on the JAM opcode at ${hex4(pc)}`);
  }

  private snapshot(): Snapshot {
    const m = this.m, c = m.cpu;
    return { ram: m.ram.slice(), port: m.cpuPort, a: c.a, x: c.x, y: c.y, s: c.s, p: c.p };
  }

  private trace(line: string): void { this.o.trace?.(line); }

  // --- traps --------------------------------------------------------------------------------------------------------

  private trap(addr: number, rom: number, run: () => boolean): void {
    this.traps.set(addr, { rom, run });
    this.special[addr] |= 1;
  }

  /** return from a routine the trap did the work of */
  private rts(cycles = 12): true {
    const m = this.m, c = m.cpu;
    c.s = (c.s + 1) & 0xff; const lo = m.read(0x100 | c.s);
    c.s = (c.s + 1) & 0xff; const hi = m.read(0x100 | c.s);
    c.pc = ((lo | (hi << 8)) + 1) & 0xffff;
    c.lastOp = 0x60;
    m.advance(cycles);
    m.icount++;
    return true;
  }

  private print(ch: number): void {
    if (!this.cur) return;
    const c = ch === 0x0d ? '\n' : ch >= 0x20 && ch < 0x5b ? String.fromCharCode(ch) : ch >= 0xc1 && ch <= 0xda ? String.fromCharCode(ch - 0x80) : '';
    if (this.cur.printed.length < 2000) this.cur.printed += c;
  }

  private fileName(): string {
    const m = this.m, len = m.ram[0xb7], at = m.ram[0xbb] | (m.ram[0xbc] << 8);
    let s = '';
    for (let i = 0; i < len && i < 32; i++) { const b = m.peek((at + i) & 0xffff); s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '?'; }
    return s;
  }

  private setupTraps(): void {
    const m = this.m, cpu = m.cpu;
    // both: LOAD and SAVE through their vectors, the KERNAL's own BRK handling, reset
    this.trap(0xf4a5, KERNAL, () => {
      if (this.phase === 'load') {
        this.loadFile();
        // from a disk the file came from device 8 (LOAD"*",8,1): loaders take the drive's number from here
        if (this.drive) { m.ram[0xba] = 8; m.ram[0xb9] = 1; }
        const end = this.loadAt + this.data.length;
        cpu.x = end & 0xff; cpu.y = (end >> 8) & 0xff; cpu.c = 0;
        this.setPhase('loaded');
        return this.rts(200);
      }
      // with a disk the KERNAL loads it from the drive
      if (this.drive && m.ram[0xba] === 8) { this.trace(`loads "${this.fileName()}"`); return false; }
      this.stop('load', `loads "${this.fileName()}" from device ${m.ram[0xba]}`);
      return true;
    });
    this.trap(0xf5ed, KERNAL, () => {
      if (this.drive && m.ram[0xba] === 8) { this.trace(`saves "${this.fileName()}"`); return false; }
      this.stop('save', `saves "${this.fileName()}"`);
      return true;
    });
    this.trap(0xfce2, KERNAL, () => { if (!this.started) return false; this.stop('reset', 'resets the C64'); return true; });
    this.trap(0xf1ca, KERNAL, () => { this.print(cpu.a); return this.real ? false : (cpu.c = 0, this.rts()); });

    if (this.real) {
      // the READY prompt waiting for a key: type LOAD, then RUN; after that the program has returned to BASIC
      this.trap(0xe5cd, KERNAL, () => {
        if (m.ram[0xc6]) return false;
        if (this.phase === 'boot') {
          bootCache.set(this.bootKey, m.save());
          this.typeLine('LOAD');
          this.setPhase('load');
        } else if (this.phase === 'loaded') {
          if (this.started) { this.stop('ready', 'returned to the READY prompt'); return true; }
          const basicStart = m.ram[0x2b] | (m.ram[0x2c] << 8);
          this.typeLine(this.o.entry != null ? `SYS${this.o.entry}` : this.loadAt === basicStart ? 'RUN' : `SYS${this.loadAt}`);
          this.setPhase('run');
        } else if (this.phase === 'run') {
          if (!this.started && !this.triedSys && this.loadAt !== (m.ram[0x2b] | (m.ram[0x2c] << 8))) {
            this.triedSys = true;
            this.typeLine(`SYS${this.loadAt}`);
          } else this.stop('ready', this.started ? 'returned to the READY prompt' : 'the BASIC program ran no machine code');
          return this.stopped;
        }
        return false;
      });
      this.trap(0xfe66, KERNAL, () => {
        if (this.started) this.cur!.printed += `{brk at ${hex4((m.peekWord(0x100 + ((cpu.s + 5) & 0xff)) - 2) & 0xffff)}}`;
        return false;
      });
      return;
    }

    // the stand-ins: SYS returning, BASIC's RUN and READY, the KERNAL routines packers call
    this.trap(SYS_RETURN + 1, KERNAL, () => {
      m.ram[0x030c] = cpu.a; m.ram[0x030d] = cpu.x; m.ram[0x030e] = cpu.y; m.ram[0x030f] = cpu.p;
      if (this.basicRunning) this.runBasic(false);
      else this.stop('ready', 'returned to BASIC');
      return true;
    });
    for (const a of [0xa7ae, 0xa871]) this.trap(a, BASIC, () => { this.runBasic(true); return true; });
    for (const a of [0xa659, 0xa660, 0xa68e]) this.trap(a, BASIC, () => {
      const start = (m.ram[0x2b] | (m.ram[0x2c] << 8)) - 1;
      m.write(0x7a, start & 0xff); m.write(0x7b, start >> 8);
      return this.returnsOrRuns();
    });
    this.trap(0xa533, BASIC, () => { this.relink(); return this.returnsOrRuns(); });
    for (const a of [0xa474, 0xa480, 0xa483]) this.trap(a, BASIC, () => { this.stop('ready', 'returned to the READY prompt'); return true; });
    for (const a of [0xe37b, 0xe386]) this.trap(a, KERNAL, () => { this.stop('ready', 'BASIC warm start'); return true; });
    this.trap(0xab1e, BASIC, () => {
      for (let p = cpu.a | (cpu.y << 8), n = 0; n < 256; n++, p = (p + 1) & 0xffff) { const b = m.peek(p); if (!b) break; this.print(b); }
      return this.rts();
    });
    this.trap(0xbdcd, BASIC, () => { for (const ch of String(cpu.x | (cpu.a << 8))) this.print(ch.charCodeAt(0)); return this.rts(); });

    this.trap(0xfe66, KERNAL, () => { this.stop('brk', `BRK at ${hex4((m.peekWord(0x100 + ((cpu.s + 5) & 0xff)) - 2) & 0xffff)}`); return true; });
    this.trap(0xea31, KERNAL, () => {
      // the KERNAL's interrupt work: the jiffy clock
      this.jiffy();
      return false;
    });
    const clearScreen = () => {
      const screen = m.ram[0x0288] << 8;
      for (let i = 0; i < 1000; i++) { m.write((screen + i) & 0xffff, 0x20); m.color[i] = m.ram[0x0286] & 0x0f; }
      return this.rts(20000);
    };
    for (const a of [0xe544, 0xff81, 0xff5b, 0xe518]) this.trap(a, KERNAL, clearScreen);
    for (const a of [0xe566, 0xff84, 0xfda3, 0xff87, 0xfd50, 0xff9f, 0xffa2, 0xff90, 0xe3bf, 0xe453, 0xe422, 0xff93, 0xff96, 0xffa8, 0xffab, 0xffae, 0xffb1, 0xffb4]) {
      this.trap(a, KERNAL, () => { if (a >= 0xff93 && a !== 0xff9f && a !== 0xffa2) m.ram[0x90] |= 0x80; return this.rts(); });
    }
    const restor = () => { KERNAL_VECTORS.forEach((v, i) => { m.write(0x0314 + 2 * i, v & 0xff); m.write(0x0315 + 2 * i, v >> 8); }); return this.rts(200); };
    this.trap(0xff8a, KERNAL, restor);
    this.trap(0xfd15, KERNAL, restor);
    this.trap(0xff8d, KERNAL, () => {
      const at = cpu.x | (cpu.y << 8);
      for (let i = 0; i < 32; i++) {
        if (cpu.c) m.write((at + i) & 0xffff, m.read(0x0314 + i)); else m.write(0x0314 + i, m.read((at + i) & 0xffff));
      }
      return this.rts(300);
    });
    this.trap(0xff99, KERNAL, () => { if (cpu.c) { cpu.x = m.ram[0x0283]; cpu.y = m.ram[0x0284]; } else { m.write(0x0283, cpu.x); m.write(0x0284, cpu.y); } return this.rts(); });
    this.trap(0xff9c, KERNAL, () => { if (cpu.c) { cpu.x = m.ram[0x0281]; cpu.y = m.ram[0x0282]; } else { m.write(0x0281, cpu.x); m.write(0x0282, cpu.y); } return this.rts(); });
    this.trap(0xffa5, KERNAL, () => { cpu.a = 0; m.ram[0x90] |= 0x02; return this.rts(); });
    this.trap(0xffb7, KERNAL, () => { cpu.a = m.ram[0x90]; cpu.n = cpu.a & 0x80; cpu.z = cpu.a ? 0 : 1; return this.rts(); });
    this.trap(0xffba, KERNAL, () => { m.write(0xb8, cpu.a); m.write(0xba, cpu.x); m.write(0xb9, cpu.y); return this.rts(); });
    this.trap(0xffbd, KERNAL, () => { m.write(0xb7, cpu.a); m.write(0xbb, cpu.x); m.write(0xbc, cpu.y); return this.rts(); });
    this.trap(0xffdb, KERNAL, () => { m.write(0xa2, cpu.a); m.write(0xa1, cpu.x); m.write(0xa0, cpu.y); return this.rts(); });
    this.trap(0xffde, KERNAL, () => { cpu.a = m.ram[0xa2]; cpu.x = m.ram[0xa1]; cpu.y = m.ram[0xa0]; return this.rts(); });
    this.trap(0xffea, KERNAL, () => { this.jiffy(); return this.rts(); });
    this.trap(0xffed, KERNAL, () => { cpu.x = 40; cpu.y = 25; return this.rts(); });
    this.trap(0xfff0, KERNAL, () => { if (cpu.c) { cpu.x = m.ram[0xd6]; cpu.y = m.ram[0xd3]; } else { m.write(0xd6, cpu.x); m.write(0xd3, cpu.y); } return this.rts(); });
    this.trap(0xfff3, KERNAL, () => { cpu.x = 0x00; cpu.y = 0xdc; return this.rts(); });
    this.trap(0xe716, KERNAL, () => { this.print(cpu.a); return this.rts(); });
    // the routines behind the RAM vectors
    this.trap(0xf13e, KERNAL, () => {
      let key = 0;
      if (m.ram[0xc6]) { key = m.ram[0x0277]; m.ram.copyWithin(0x0277, 0x0278, 0x0281); m.ram[0xc6]--; }
      else if (m.input.petscii) { key = m.input.petscii; m.input.petscii = 0; }
      cpu.a = key; cpu.n = key & 0x80; cpu.z = key ? 0 : 1; cpu.c = 0;
      return this.rts();
    });
    this.trap(0xf157, KERNAL, () => { cpu.a = 0x0d; cpu.c = 0; return this.rts(); });
    this.trap(0xf6ed, KERNAL, () => { cpu.z = 0; return this.rts(); });
    this.trap(0xf34a, KERNAL, () => { cpu.a = 5; cpu.c = 1; return this.rts(); });
    for (const a of [0xf291, 0xf333, 0xf32f, 0xf20e, 0xf250]) this.trap(a, KERNAL, () => { cpu.c = 0; return this.rts(); });
  }

  private jiffy(): void {
    const ram = this.m.ram;
    // (++ on a typed array element gives 256, not the 0 it stores)
    ram[0xa2]++;
    if (ram[0xa2] === 0) { ram[0xa1]++; if (ram[0xa1] === 0) ram[0xa0]++; }
  }

  /** after a stand-in BASIC routine: return when it was called (JSR), go on with RUN when it was jumped to */
  private returnsOrRuns(): boolean {
    if (this.m.cpu.lastOp === 0x20) return this.rts();
    this.runBasic(true);
    return true;
  }

  /** BASIC's LINKPRG: set every line's link to the line after it */
  private relink(): void {
    const m = this.m;
    let a = m.ram[0x2b] | (m.ram[0x2c] << 8);
    for (let n = 0; n < 2000; n++) {
      if (!m.ram[(a + 1) & 0xffff]) break;
      let p = (a + 4) & 0xffff;
      while (m.ram[p] && p < 0xffff) p++;
      const next = p + 1;
      m.write(a, next & 0xff); m.write((a + 1) & 0xffff, next >> 8);
      a = next;
    }
  }

  /** The stand-in SYS: registers from $030c-$030f, and a return address that lands on a trap. */
  private sys(addr: number): void {
    const m = this.m, c = m.cpu;
    c.a = m.ram[0x030c]; c.x = m.ram[0x030d]; c.y = m.ram[0x030e]; c.p = m.ram[0x030f];
    m.write(0x100 | c.s, SYS_RETURN >> 8); c.s = (c.s - 1) & 0xff;
    m.write(0x100 | c.s, SYS_RETURN & 0xff); c.s = (c.s - 1) & 0xff;
    c.pc = addr;
    c.lastOp = 0x20;
  }

  /**
   * The stand-in BASIC: runs the statements a packer's start line has (SYS, POKE, PRINT, REM, CLR, END). Anything
   * else needs the real BASIC.
   */
  private runBasic(fromStart: boolean): void {
    const m = this.m;
    const peek = (a: number) => m.peek(a);
    if (fromStart) {
      const start = m.ram[0x2b] | (m.ram[0x2c] << 8);
      this.basicStatements = basicLines(peek, start, 256).flatMap(l => statements(l.bytes));
      this.basicPos = 0;
    }
    this.basicRunning = true;
    while (this.basicPos < this.basicStatements.length) {
      const st = this.basicStatements[this.basicPos++];
      const k = st.findIndex(b => b !== 0x20);
      if (k < 0) continue;
      const op = st[k], rest = st.slice(k + 1);
      if (op === T.REM || op === T.PRINT || op === T.CLR) continue;
      if (op === T.END || op === T.STOP) break;
      if (op === T.SYS) {
        const r = evaluate(rest, peek);
        if (!r) { this.stop('needs-rom', 'the SYS needs the real BASIC to work out'); return; }
        this.m.cpu.s = 0xf8;
        this.sys(Math.trunc(r.value) & 0xffff);
        return;
      }
      if (op === T.POKE) {
        const a = evaluate(rest, peek);
        const v = a && a.rest[0] === 0x2c ? evaluate(a.rest.slice(1), peek) : null;
        if (!a || !v) { this.stop('needs-rom', 'the POKE needs the real BASIC to work out'); return; }
        m.write(Math.trunc(a.value) & 0xffff, Math.trunc(v.value) & 0xff);
        continue;
      }
      this.stop('needs-rom', 'the BASIC program needs the ROM files to run');
      return;
    }
    this.basicRunning = false;
    this.stop('ready', 'the BASIC program ended');
  }

  // --- the result ---------------------------------------------------------------------------------------------------

  private finish(ms: number): UnpackResult {
    const m = this.m;
    const last = this.layers[this.layers.length - 1];
    if (last) {
      last.activity = activity(m, this.eid, last.id, last.icount);
      last.activity.kind = 'program';
    }
    const peekFile = (a: number) => a >= this.loadAt && a < this.loadAt + this.data.length ? this.data[a - this.loadAt] : 0;
    const basic = this.loadAt === 0x0801 ? basicLines(peekFile, 0x0801, 8).map(listLine) : [];
    const reports = this.layers.map((l, i) => this.report(l, i));
    const save = (index: number, clean = this.o.clean ?? false): Saved | null => this.saveLayer(index, clean);
    // a last layer that soon resets or crashes is not a program (an intro's exit, a protection's trap)
    let best = this.layers.length - 1;
    const r = this.stopInfo.reason;
    if (best > 0 && (r === 'reset' || r === 'jam' || r === 'brk') && last.activity!.instructions < 2000) best--;
    const want = this.o.layer ?? (best > 0 ? best : -1);
    return {
      unpacked: best > 0,
      stop: this.stopInfo,
      layers: reports,
      saved: want >= 0 ? save(want) : null,
      save,
      basic,
      roms: this.real ? this.o.roms!.source : 'stand-ins (no ROM files)',
      drive: this.drive ? `${this.driveNote}, ${this.drive.bytesRead} bytes read${this.drive.bytesWritten ? `, ${this.drive.bytesWritten} written` : ''}` : this.driveNote,
      cycles: this.started ? m.cycles - this.startCycle : 0,
      ms,
    };
  }

  private report(l: Layer, index: number): LayerReport {
    const a = l.activity ?? activity(this.m, this.eid, l.id, l.icount);
    const ram = l.snapshot.ram;
    const around = a.code.map(r => ({ start: Math.max(0, r.start - 256), end: Math.min(0xffff, r.end + 256) }));
    const packer = a.kind === 'program' ? null : identify(a.opcodes);
    return {
      index, entry: l.entry, via: l.via, from: l.from, cycle: l.cycle - this.startCycle, basic: l.basic,
      kind: a.kind, code: a.code, instructions: a.instructions,
      written: a.written, writtenBytes: a.writtenBytes, read: a.read, readBytes: a.readBytes,
      calls: l.calls, fingerprint: fingerprintId(a.opcodes), opcodes: a.opcodes, packer,
      text: strings(p => ram[p], around).slice(0, 12),
      printed: l.printed, presses: l.presses,
      range: index > 0 && l.mask ? this.rangeOf(l) : null,
    };
  }

  private rangeOf(l: Layer): Range | null {
    const ram = l.snapshot.ram;
    if (!l.basic) return saveRange(l.mask!, [l.entry]);
    const start = ram[0x2b] | (ram[0x2c] << 8), end = (ram[0x2d] | (ram[0x2e] << 8)) - 1;
    const r = saveRange(l.mask!, [start]);
    return { start: Math.min(r?.start ?? start, start), end: Math.max(r?.end ?? end, end) };
  }

  private saveLayer(index: number, clean: boolean): Saved | null {
    const l = this.layers[index];
    if (!l) return null;
    const s = l.snapshot;
    if (index === 0) {
      return { layer: 0, prg: this.file.slice(), start: this.loadAt, end: this.loadAt + this.data.length - 1, entry: l.entry, basic: false, port: s.port, interrupts: !(s.p & 4) };
    }
    const range = this.rangeOf(l);
    if (!range) return null;
    const prg = buildPrg(s.ram, range, clean ? l.mask! : undefined);
    const basicStart = s.ram[0x2b] | (s.ram[0x2c] << 8);
    const entry = l.basic ? findSys(a => s.ram[a], basicStart) ?? basicStart : l.entry;
    return { layer: index, prg, start: range.start, end: range.end, entry, basic: l.basic, port: s.port, interrupts: !(s.p & 4) };
  }
}

function checksum(bytes: Uint8Array): string {
  let h = 0;
  for (let i = 0; i < bytes.length; i++) h = (Math.imul(h, 31) + bytes[i]) >>> 0;
  return h.toString(16);
}
