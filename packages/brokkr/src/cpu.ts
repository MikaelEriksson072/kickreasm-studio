/* The 6510 CPU: all 256 opcodes (the undocumented ones as VICE runs them), decimal mode, and the cycle count of
 * every instruction, page crossings and taken branches included. Memory goes through a Bus. */

export interface Bus {
  /** a data read, which may have side effects (I/O registers) */
  read(addr: number): number;
  write(addr: number, value: number): void;
  /** an opcode or operand fetch */
  fetch(addr: number): number;
}

/** lastOp values for the interrupts, after the 256 opcodes */
export const OP_IRQ = 0x100;
export const OP_NMI = 0x101;

/** the constant ANE and LXA mix into A (it varies between chips; VICE uses $ee) */
const MAGIC = 0xee;

// read-modify-write kinds
const ASL = 0, ROL = 1, LSR = 2, ROR = 3, DEC = 4, INC = 5;

export class Cpu {
  a = 0; x = 0; y = 0; s = 0xff; pc = 0;
  /** flags: n is 0 or $80, the others 0 or 1 */
  n = 0; v = 0; d = 0; i = 1; z = 0; c = 0;
  /** a JAM opcode stopped the CPU */
  jammed = false;
  /** the opcode of the last instruction, or OP_IRQ/OP_NMI after an interrupt */
  lastOp = 0;
  private extra = 0;
  private readonly bus: Bus;

  constructor(bus: Bus) { this.bus = bus; }

  get p(): number { return this.n | (this.v << 6) | 0x20 | (this.d << 3) | (this.i << 2) | (this.z << 1) | this.c; }
  set p(value: number) {
    this.n = value & 0x80; this.v = (value >> 6) & 1; this.d = (value >> 3) & 1;
    this.i = (value >> 2) & 1; this.z = (value >> 1) & 1; this.c = value & 1;
  }

  /** take an IRQ (the caller checks the I flag); returns the cycles */
  irq(): number { this.interrupt(0xfffe, 0); this.lastOp = OP_IRQ; return 7; }
  nmi(): number { this.interrupt(0xfffa, 0); this.lastOp = OP_NMI; return 7; }

  private interrupt(vector: number, b: number): void {
    this.push(this.pc >> 8); this.push(this.pc & 0xff); this.push(this.p | b);
    this.i = 1;
    this.pc = this.bus.read(vector) | (this.bus.read(vector + 1) << 8);
  }

  // --- addressing -------------------------------------------------------------------------------------------------
  private imm(): number { const v = this.bus.fetch(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  private abs(): number { const lo = this.imm(); return lo | (this.imm() << 8); }
  private zpx(): number { return (this.imm() + this.x) & 0xff; }
  private zpy(): number { return (this.imm() + this.y) & 0xff; }
  private abx(penalty: boolean): number {
    const b = this.abs(), a = (b + this.x) & 0xffff;
    if (penalty && (a ^ b) & 0xff00) this.extra = 1;
    return a;
  }
  private aby(penalty: boolean): number {
    const b = this.abs(), a = (b + this.y) & 0xffff;
    if (penalty && (a ^ b) & 0xff00) this.extra = 1;
    return a;
  }
  private izx(): number { const p = (this.imm() + this.x) & 0xff; return this.bus.read(p) | (this.bus.read((p + 1) & 0xff) << 8); }
  private izy(penalty: boolean): number {
    const p = this.imm(), b = this.bus.read(p) | (this.bus.read((p + 1) & 0xff) << 8), a = (b + this.y) & 0xffff;
    if (penalty && (a ^ b) & 0xff00) this.extra = 1;
    return a;
  }
  /** the base of the last indexed address, for SHA/SHX/SHY/TAS */
  private indexedHi(a: number, index: number): number { return ((a - index) >> 8) & 0xff; }

  private rd(a: number): number { return this.bus.read(a); }
  private wr(a: number, v: number): void { this.bus.write(a, v); }
  private push(v: number): void { this.bus.write(0x100 | this.s, v); this.s = (this.s - 1) & 0xff; }
  private pull(): number { this.s = (this.s + 1) & 0xff; return this.bus.read(0x100 | this.s); }

  private branch(taken: boolean): void {
    const o = this.imm();
    if (!taken) return;
    const t = (this.pc + ((o ^ 0x80) - 0x80)) & 0xffff;
    this.extra = (t ^ this.pc) & 0xff00 ? 2 : 1;
    this.pc = t;
  }

  // --- operations -------------------------------------------------------------------------------------------------
  private nz(v: number): number { this.n = v & 0x80; this.z = v === 0 ? 1 : 0; return v; }
  private ora(v: number): void { this.a = this.nz(this.a | v); }
  private and(v: number): void { this.a = this.nz(this.a & v); }
  private eor(v: number): void { this.a = this.nz(this.a ^ v); }
  private cmp(r: number, v: number): void { const t = r - v; this.c = t >= 0 ? 1 : 0; this.nz(t & 0xff); }
  private bit(v: number): void { this.n = v & 0x80; this.v = (v >> 6) & 1; this.z = (this.a & v) === 0 ? 1 : 0; }

  private adc(v: number): void {
    const a = this.a, c = this.c;
    if (this.d) {
      let lo = (a & 0x0f) + (v & 0x0f) + c;
      if (lo > 9) lo += 6;
      let t = (lo & 0x0f) + (a & 0xf0) + (v & 0xf0) + (lo > 0x0f ? 0x10 : 0);
      this.z = ((a + v + c) & 0xff) === 0 ? 1 : 0;
      this.n = t & 0x80;
      this.v = (a ^ t) & 0x80 && !((a ^ v) & 0x80) ? 1 : 0;
      if ((t & 0x1f0) > 0x90) t += 0x60;
      this.c = (t & 0xff0) > 0xf0 ? 1 : 0;
      this.a = t & 0xff;
    } else {
      const t = a + v + c;
      this.v = ~(a ^ v) & (a ^ t) & 0x80 ? 1 : 0;
      this.c = t > 0xff ? 1 : 0;
      this.a = this.nz(t & 0xff);
    }
  }

  private sbc(v: number): void {
    const a = this.a, borrow = 1 - this.c;
    const t = a - v - borrow;
    this.c = t >= 0 ? 1 : 0;
    this.v = (a ^ t) & 0x80 && (a ^ v) & 0x80 ? 1 : 0;
    this.nz(t & 0xff);
    if (this.d) {
      const lo = (a & 0x0f) - (v & 0x0f) - borrow;
      let r = lo & 0x10 ? ((lo - 6) & 0x0f) | ((a & 0xf0) - (v & 0xf0) - 0x10) : (lo & 0x0f) | ((a & 0xf0) - (v & 0xf0));
      if (r & 0x100) r -= 0x60;
      this.a = r & 0xff;
    } else this.a = t & 0xff;
  }

  private shift(kind: number, v: number): number {
    switch (kind) {
      case ASL: this.c = v >> 7; return this.nz((v << 1) & 0xff);
      case ROL: { const r = ((v << 1) | this.c) & 0xff; this.c = v >> 7; return this.nz(r); }
      case LSR: this.c = v & 1; return this.nz(v >> 1);
      case ROR: { const r = (v >> 1) | (this.c << 7); this.c = v & 1; return this.nz(r); }
      case DEC: return this.nz((v - 1) & 0xff);
      default: return this.nz((v + 1) & 0xff);
    }
  }

  /** Read-modify-write: the 6510 writes the old value back first, which only I/O registers (such as $d019) see. */
  private rmw(a: number, kind: number): number {
    const v = this.rd(a);
    if ((a & 0xf000) === 0xd000) this.wr(a, v);
    const r = this.shift(kind, v);
    this.wr(a, r);
    return r;
  }

  private slo(a: number): void { this.ora(this.rmw(a, ASL)); }
  private rla(a: number): void { this.and(this.rmw(a, ROL)); }
  private sre(a: number): void { this.eor(this.rmw(a, LSR)); }
  private rra(a: number): void { this.adc(this.rmw(a, ROR)); }
  private dcp(a: number): void { this.cmp(this.a, this.rmw(a, DEC)); }
  private isc(a: number): void { this.sbc(this.rmw(a, INC)); }
  private lax(v: number): void { this.a = this.x = this.nz(v); }

  private arr(v: number): void {
    const t = this.a & v;
    if (this.d) {
      let r = (t >> 1) | (this.c << 7);
      this.n = this.c << 7; this.z = r === 0 ? 1 : 0; this.v = (r ^ t) & 0x40 ? 1 : 0;
      if ((t & 0x0f) + (t & 0x01) > 0x05) r = (r & 0xf0) | ((r + 0x06) & 0x0f);
      if ((t & 0xf0) + (t & 0x10) > 0x50) { r = (r & 0x0f) | ((r + 0x60) & 0xf0); this.c = 1; } else this.c = 0;
      this.a = r & 0xff;
    } else {
      const r = this.nz((t >> 1) | (this.c << 7));
      this.c = (r >> 6) & 1;
      this.v = ((r >> 6) ^ (r >> 5)) & 1;
      this.a = r;
    }
  }

  /** SHA/SHX/SHY/TAS store `v & (base high byte + 1)`; on a page crossing that value also becomes the high byte. */
  private shStore(a: number, index: number, v: number): void {
    const hi = this.indexedHi(a, index);
    const value = v & ((hi + 1) & 0xff);
    if (hi !== a >> 8) a = (value << 8) | (a & 0xff);
    this.wr(a, value);
  }

  // --- one instruction ---------------------------------------------------------------------------------------------
  /** Execute one instruction; returns its cycles. */
  step(): number {
    const op = this.bus.fetch(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    this.extra = 0;
    this.lastOp = op;
    let a: number;
    switch (op) {
      // ORA
      case 0x09: this.ora(this.imm()); return 2;
      case 0x05: this.ora(this.rd(this.imm())); return 3;
      case 0x15: this.ora(this.rd(this.zpx())); return 4;
      case 0x0d: this.ora(this.rd(this.abs())); return 4;
      case 0x1d: this.ora(this.rd(this.abx(true))); return 4 + this.extra;
      case 0x19: this.ora(this.rd(this.aby(true))); return 4 + this.extra;
      case 0x01: this.ora(this.rd(this.izx())); return 6;
      case 0x11: this.ora(this.rd(this.izy(true))); return 5 + this.extra;
      // AND
      case 0x29: this.and(this.imm()); return 2;
      case 0x25: this.and(this.rd(this.imm())); return 3;
      case 0x35: this.and(this.rd(this.zpx())); return 4;
      case 0x2d: this.and(this.rd(this.abs())); return 4;
      case 0x3d: this.and(this.rd(this.abx(true))); return 4 + this.extra;
      case 0x39: this.and(this.rd(this.aby(true))); return 4 + this.extra;
      case 0x21: this.and(this.rd(this.izx())); return 6;
      case 0x31: this.and(this.rd(this.izy(true))); return 5 + this.extra;
      // EOR
      case 0x49: this.eor(this.imm()); return 2;
      case 0x45: this.eor(this.rd(this.imm())); return 3;
      case 0x55: this.eor(this.rd(this.zpx())); return 4;
      case 0x4d: this.eor(this.rd(this.abs())); return 4;
      case 0x5d: this.eor(this.rd(this.abx(true))); return 4 + this.extra;
      case 0x59: this.eor(this.rd(this.aby(true))); return 4 + this.extra;
      case 0x41: this.eor(this.rd(this.izx())); return 6;
      case 0x51: this.eor(this.rd(this.izy(true))); return 5 + this.extra;
      // ADC
      case 0x69: this.adc(this.imm()); return 2;
      case 0x65: this.adc(this.rd(this.imm())); return 3;
      case 0x75: this.adc(this.rd(this.zpx())); return 4;
      case 0x6d: this.adc(this.rd(this.abs())); return 4;
      case 0x7d: this.adc(this.rd(this.abx(true))); return 4 + this.extra;
      case 0x79: this.adc(this.rd(this.aby(true))); return 4 + this.extra;
      case 0x61: this.adc(this.rd(this.izx())); return 6;
      case 0x71: this.adc(this.rd(this.izy(true))); return 5 + this.extra;
      // SBC (EB is the undocumented copy of E9)
      case 0xe9: case 0xeb: this.sbc(this.imm()); return 2;
      case 0xe5: this.sbc(this.rd(this.imm())); return 3;
      case 0xf5: this.sbc(this.rd(this.zpx())); return 4;
      case 0xed: this.sbc(this.rd(this.abs())); return 4;
      case 0xfd: this.sbc(this.rd(this.abx(true))); return 4 + this.extra;
      case 0xf9: this.sbc(this.rd(this.aby(true))); return 4 + this.extra;
      case 0xe1: this.sbc(this.rd(this.izx())); return 6;
      case 0xf1: this.sbc(this.rd(this.izy(true))); return 5 + this.extra;
      // CMP, CPX, CPY
      case 0xc9: this.cmp(this.a, this.imm()); return 2;
      case 0xc5: this.cmp(this.a, this.rd(this.imm())); return 3;
      case 0xd5: this.cmp(this.a, this.rd(this.zpx())); return 4;
      case 0xcd: this.cmp(this.a, this.rd(this.abs())); return 4;
      case 0xdd: this.cmp(this.a, this.rd(this.abx(true))); return 4 + this.extra;
      case 0xd9: this.cmp(this.a, this.rd(this.aby(true))); return 4 + this.extra;
      case 0xc1: this.cmp(this.a, this.rd(this.izx())); return 6;
      case 0xd1: this.cmp(this.a, this.rd(this.izy(true))); return 5 + this.extra;
      case 0xe0: this.cmp(this.x, this.imm()); return 2;
      case 0xe4: this.cmp(this.x, this.rd(this.imm())); return 3;
      case 0xec: this.cmp(this.x, this.rd(this.abs())); return 4;
      case 0xc0: this.cmp(this.y, this.imm()); return 2;
      case 0xc4: this.cmp(this.y, this.rd(this.imm())); return 3;
      case 0xcc: this.cmp(this.y, this.rd(this.abs())); return 4;
      // BIT
      case 0x24: this.bit(this.rd(this.imm())); return 3;
      case 0x2c: this.bit(this.rd(this.abs())); return 4;
      // LDA
      case 0xa9: this.a = this.nz(this.imm()); return 2;
      case 0xa5: this.a = this.nz(this.rd(this.imm())); return 3;
      case 0xb5: this.a = this.nz(this.rd(this.zpx())); return 4;
      case 0xad: this.a = this.nz(this.rd(this.abs())); return 4;
      case 0xbd: this.a = this.nz(this.rd(this.abx(true))); return 4 + this.extra;
      case 0xb9: this.a = this.nz(this.rd(this.aby(true))); return 4 + this.extra;
      case 0xa1: this.a = this.nz(this.rd(this.izx())); return 6;
      case 0xb1: this.a = this.nz(this.rd(this.izy(true))); return 5 + this.extra;
      // LDX, LDY
      case 0xa2: this.x = this.nz(this.imm()); return 2;
      case 0xa6: this.x = this.nz(this.rd(this.imm())); return 3;
      case 0xb6: this.x = this.nz(this.rd(this.zpy())); return 4;
      case 0xae: this.x = this.nz(this.rd(this.abs())); return 4;
      case 0xbe: this.x = this.nz(this.rd(this.aby(true))); return 4 + this.extra;
      case 0xa0: this.y = this.nz(this.imm()); return 2;
      case 0xa4: this.y = this.nz(this.rd(this.imm())); return 3;
      case 0xb4: this.y = this.nz(this.rd(this.zpx())); return 4;
      case 0xac: this.y = this.nz(this.rd(this.abs())); return 4;
      case 0xbc: this.y = this.nz(this.rd(this.abx(true))); return 4 + this.extra;
      // STA, STX, STY
      case 0x85: this.wr(this.imm(), this.a); return 3;
      case 0x95: this.wr(this.zpx(), this.a); return 4;
      case 0x8d: this.wr(this.abs(), this.a); return 4;
      case 0x9d: this.wr(this.abx(false), this.a); return 5;
      case 0x99: this.wr(this.aby(false), this.a); return 5;
      case 0x81: this.wr(this.izx(), this.a); return 6;
      case 0x91: this.wr(this.izy(false), this.a); return 6;
      case 0x86: this.wr(this.imm(), this.x); return 3;
      case 0x96: this.wr(this.zpy(), this.x); return 4;
      case 0x8e: this.wr(this.abs(), this.x); return 4;
      case 0x84: this.wr(this.imm(), this.y); return 3;
      case 0x94: this.wr(this.zpx(), this.y); return 4;
      case 0x8c: this.wr(this.abs(), this.y); return 4;
      // shifts and rotates
      case 0x0a: this.a = this.shift(ASL, this.a); return 2;
      case 0x06: this.rmw(this.imm(), ASL); return 5;
      case 0x16: this.rmw(this.zpx(), ASL); return 6;
      case 0x0e: this.rmw(this.abs(), ASL); return 6;
      case 0x1e: this.rmw(this.abx(false), ASL); return 7;
      case 0x2a: this.a = this.shift(ROL, this.a); return 2;
      case 0x26: this.rmw(this.imm(), ROL); return 5;
      case 0x36: this.rmw(this.zpx(), ROL); return 6;
      case 0x2e: this.rmw(this.abs(), ROL); return 6;
      case 0x3e: this.rmw(this.abx(false), ROL); return 7;
      case 0x4a: this.a = this.shift(LSR, this.a); return 2;
      case 0x46: this.rmw(this.imm(), LSR); return 5;
      case 0x56: this.rmw(this.zpx(), LSR); return 6;
      case 0x4e: this.rmw(this.abs(), LSR); return 6;
      case 0x5e: this.rmw(this.abx(false), LSR); return 7;
      case 0x6a: this.a = this.shift(ROR, this.a); return 2;
      case 0x66: this.rmw(this.imm(), ROR); return 5;
      case 0x76: this.rmw(this.zpx(), ROR); return 6;
      case 0x6e: this.rmw(this.abs(), ROR); return 6;
      case 0x7e: this.rmw(this.abx(false), ROR); return 7;
      // INC, DEC
      case 0xe6: this.rmw(this.imm(), INC); return 5;
      case 0xf6: this.rmw(this.zpx(), INC); return 6;
      case 0xee: this.rmw(this.abs(), INC); return 6;
      case 0xfe: this.rmw(this.abx(false), INC); return 7;
      case 0xc6: this.rmw(this.imm(), DEC); return 5;
      case 0xd6: this.rmw(this.zpx(), DEC); return 6;
      case 0xce: this.rmw(this.abs(), DEC); return 6;
      case 0xde: this.rmw(this.abx(false), DEC); return 7;
      case 0xe8: this.x = this.nz((this.x + 1) & 0xff); return 2;
      case 0xc8: this.y = this.nz((this.y + 1) & 0xff); return 2;
      case 0xca: this.x = this.nz((this.x - 1) & 0xff); return 2;
      case 0x88: this.y = this.nz((this.y - 1) & 0xff); return 2;
      // transfers
      case 0xaa: this.x = this.nz(this.a); return 2;
      case 0x8a: this.a = this.nz(this.x); return 2;
      case 0xa8: this.y = this.nz(this.a); return 2;
      case 0x98: this.a = this.nz(this.y); return 2;
      case 0xba: this.x = this.nz(this.s); return 2;
      case 0x9a: this.s = this.x; return 2;
      // stack
      case 0x48: this.push(this.a); return 3;
      case 0x68: this.a = this.nz(this.pull()); return 4;
      case 0x08: this.push(this.p | 0x10); return 3;
      case 0x28: this.p = this.pull(); return 4;
      // flags
      case 0x18: this.c = 0; return 2;
      case 0x38: this.c = 1; return 2;
      case 0x58: this.i = 0; return 2;
      case 0x78: this.i = 1; return 2;
      case 0xb8: this.v = 0; return 2;
      case 0xd8: this.d = 0; return 2;
      case 0xf8: this.d = 1; return 2;
      // branches
      case 0x10: this.branch(!this.n); return 2 + this.extra;
      case 0x30: this.branch(!!this.n); return 2 + this.extra;
      case 0x50: this.branch(!this.v); return 2 + this.extra;
      case 0x70: this.branch(!!this.v); return 2 + this.extra;
      case 0x90: this.branch(!this.c); return 2 + this.extra;
      case 0xb0: this.branch(!!this.c); return 2 + this.extra;
      case 0xd0: this.branch(!this.z); return 2 + this.extra;
      case 0xf0: this.branch(!!this.z); return 2 + this.extra;
      // jumps
      case 0x4c: this.pc = this.abs(); return 3;
      case 0x6c: {
        const p = this.abs();
        this.pc = this.rd(p) | (this.rd((p & 0xff00) | ((p + 1) & 0xff)) << 8);
        return 5;
      }
      case 0x20: {
        const lo = this.imm();
        this.push(this.pc >> 8); this.push(this.pc & 0xff);
        this.pc = lo | (this.bus.fetch(this.pc) << 8);
        return 6;
      }
      case 0x60: { const lo = this.pull(); this.pc = ((lo | (this.pull() << 8)) + 1) & 0xffff; return 6; }
      case 0x40: { this.p = this.pull(); const lo = this.pull(); this.pc = lo | (this.pull() << 8); return 6; }
      case 0x00: this.pc = (this.pc + 1) & 0xffff; this.interrupt(0xfffe, 0x10); return 7;
      // NOPs: implied, immediate, zero page, zero page,x, absolute, absolute,x (reads, with the page penalty)
      case 0xea: case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa: return 2;
      case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2: this.imm(); return 2;
      case 0x04: case 0x44: case 0x64: this.rd(this.imm()); return 3;
      case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4: this.rd(this.zpx()); return 4;
      case 0x0c: this.rd(this.abs()); return 4;
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc: this.rd(this.abx(true)); return 4 + this.extra;
      // SLO, RLA, SRE, RRA, DCP, ISC: zp, zp,x, abs, abs,x, abs,y, (zp,x), (zp),y
      case 0x07: this.slo(this.imm()); return 5;
      case 0x17: this.slo(this.zpx()); return 6;
      case 0x0f: this.slo(this.abs()); return 6;
      case 0x1f: this.slo(this.abx(false)); return 7;
      case 0x1b: this.slo(this.aby(false)); return 7;
      case 0x03: this.slo(this.izx()); return 8;
      case 0x13: this.slo(this.izy(false)); return 8;
      case 0x27: this.rla(this.imm()); return 5;
      case 0x37: this.rla(this.zpx()); return 6;
      case 0x2f: this.rla(this.abs()); return 6;
      case 0x3f: this.rla(this.abx(false)); return 7;
      case 0x3b: this.rla(this.aby(false)); return 7;
      case 0x23: this.rla(this.izx()); return 8;
      case 0x33: this.rla(this.izy(false)); return 8;
      case 0x47: this.sre(this.imm()); return 5;
      case 0x57: this.sre(this.zpx()); return 6;
      case 0x4f: this.sre(this.abs()); return 6;
      case 0x5f: this.sre(this.abx(false)); return 7;
      case 0x5b: this.sre(this.aby(false)); return 7;
      case 0x43: this.sre(this.izx()); return 8;
      case 0x53: this.sre(this.izy(false)); return 8;
      case 0x67: this.rra(this.imm()); return 5;
      case 0x77: this.rra(this.zpx()); return 6;
      case 0x6f: this.rra(this.abs()); return 6;
      case 0x7f: this.rra(this.abx(false)); return 7;
      case 0x7b: this.rra(this.aby(false)); return 7;
      case 0x63: this.rra(this.izx()); return 8;
      case 0x73: this.rra(this.izy(false)); return 8;
      case 0xc7: this.dcp(this.imm()); return 5;
      case 0xd7: this.dcp(this.zpx()); return 6;
      case 0xcf: this.dcp(this.abs()); return 6;
      case 0xdf: this.dcp(this.abx(false)); return 7;
      case 0xdb: this.dcp(this.aby(false)); return 7;
      case 0xc3: this.dcp(this.izx()); return 8;
      case 0xd3: this.dcp(this.izy(false)); return 8;
      case 0xe7: this.isc(this.imm()); return 5;
      case 0xf7: this.isc(this.zpx()); return 6;
      case 0xef: this.isc(this.abs()); return 6;
      case 0xff: this.isc(this.abx(false)); return 7;
      case 0xfb: this.isc(this.aby(false)); return 7;
      case 0xe3: this.isc(this.izx()); return 8;
      case 0xf3: this.isc(this.izy(false)); return 8;
      // SAX, LAX
      case 0x87: this.wr(this.imm(), this.a & this.x); return 3;
      case 0x97: this.wr(this.zpy(), this.a & this.x); return 4;
      case 0x8f: this.wr(this.abs(), this.a & this.x); return 4;
      case 0x83: this.wr(this.izx(), this.a & this.x); return 6;
      case 0xa7: this.lax(this.rd(this.imm())); return 3;
      case 0xb7: this.lax(this.rd(this.zpy())); return 4;
      case 0xaf: this.lax(this.rd(this.abs())); return 4;
      case 0xbf: this.lax(this.rd(this.aby(true))); return 4 + this.extra;
      case 0xa3: this.lax(this.rd(this.izx())); return 6;
      case 0xb3: this.lax(this.rd(this.izy(true))); return 5 + this.extra;
      // the immediate ones
      case 0x0b: case 0x2b: this.and(this.imm()); this.c = this.n >> 7; return 2;
      case 0x4b: this.and(this.imm()); this.a = this.shift(LSR, this.a); return 2;
      case 0x6b: this.arr(this.imm()); return 2;
      case 0x8b: this.a = this.nz((this.a | MAGIC) & this.x & this.imm()); return 2;
      case 0xab: this.lax((this.a | MAGIC) & this.imm()); return 2;
      case 0xcb: { const t = (this.a & this.x) - this.imm(); this.c = t >= 0 ? 1 : 0; this.x = this.nz(t & 0xff); return 2; }
      // the unstable stores, and LAS
      case 0x93: a = this.izy(false); this.shStore(a, this.y, this.a & this.x); return 6;
      case 0x9f: a = this.aby(false); this.shStore(a, this.y, this.a & this.x); return 5;
      case 0x9e: a = this.aby(false); this.shStore(a, this.y, this.x); return 5;
      case 0x9c: a = this.abx(false); this.shStore(a, this.x, this.y); return 5;
      case 0x9b: a = this.aby(false); this.s = this.a & this.x; this.shStore(a, this.y, this.s); return 5;
      case 0xbb: { const v = this.rd(this.aby(true)) & this.s; this.a = this.x = this.s = this.nz(v); return 4 + this.extra; }
      // JAM: the CPU stops on this opcode
      default:
        this.jammed = true;
        this.pc = (this.pc - 1) & 0xffff;
        return 0;
    }
  }
}
