/* The MOS 6522 VIA as the 1541 uses it: both ports with their data direction, timer 1 (one-shot and free-running),
 * timer 2 (one-shot), the interrupt flags and enable, the CA1 and CB1 edges, and the CA2 and CB2 outputs the PCR
 * sets. The shift register and timer 2's pulse counting are left out: the 1541 does not use them. */

export interface ViaState {
  ora: number; orb: number; ddra: number; ddrb: number;
  t1c: number; t1l: number; t2c: number; t2l: number; t1run: boolean; t2run: boolean;
  acr: number; pcr: number; ifr: number; ier: number; sr: number; ca1: boolean; cb1: boolean;
}

export class Via {
  ora = 0; orb = 0; ddra = 0; ddrb = 0;
  /** timer 1's counter and latch, timer 2's counter and low latch */
  t1c = 0xffff; t1l = 0xffff; t2c = 0xffff; t2l = 0xff;
  /** the timer will set its interrupt flag when it runs out (a one-shot timer sets it once) */
  t1run = false; t2run = false;
  acr = 0; pcr = 0; ifr = 0; ier = 0; sr = 0;
  /** the last level on CA1 and CB1, for their edges */
  ca1 = false; cb1 = false;
  /** the levels the outside world drives on the port pins */
  inputA: () => number = () => 0xff;
  inputB: () => number = () => 0xff;
  /** after the program changed port A or B (its output register or data direction) */
  changedA: () => void = () => undefined;
  changedB: () => void = () => undefined;

  /** the levels a port puts out: its output bits, and the inputs pulled high */
  get outA(): number { return (this.ora | ~this.ddra) & 0xff; }
  get outB(): number { return (this.orb | ~this.ddrb) & 0xff; }
  get irq(): boolean { return (this.ifr & this.ier & 0x7f) !== 0; }
  /** CA2 and CB2 as outputs: high unless the PCR sets them low (manual output) */
  get ca2(): boolean { return ((this.pcr >> 1) & 7) !== 6; }
  get cb2(): boolean { return ((this.pcr >> 5) & 7) !== 6; }

  read(r: number): number {
    switch (r) {
      case 0x0: this.ifr &= ~0x18; return ((this.orb & this.ddrb) | (this.inputB() & ~this.ddrb)) & 0xff;
      case 0x1: this.ifr &= ~0x03; return ((this.ora & this.ddra) | (this.inputA() & ~this.ddra)) & 0xff;
      case 0x2: return this.ddrb;
      case 0x3: return this.ddra;
      case 0x4: this.ifr &= ~0x40; return this.t1c & 0xff;
      case 0x5: return (this.t1c >> 8) & 0xff;
      case 0x6: return this.t1l & 0xff;
      case 0x7: return this.t1l >> 8;
      case 0x8: this.ifr &= ~0x20; return this.t2c & 0xff;
      case 0x9: return (this.t2c >> 8) & 0xff;
      case 0xa: return this.sr;
      case 0xb: return this.acr;
      case 0xc: return this.pcr;
      case 0xd: return this.ifr | (this.irq ? 0x80 : 0);
      case 0xe: return this.ier | 0x80;
      default: return ((this.ora & this.ddra) | (this.inputA() & ~this.ddra)) & 0xff;
    }
  }

  write(r: number, v: number): void {
    switch (r) {
      case 0x0: this.orb = v; this.ifr &= ~0x18; this.changedB(); return;
      case 0x1: this.ora = v; this.ifr &= ~0x03; this.changedA(); return;
      case 0x2: this.ddrb = v; this.changedB(); return;
      case 0x3: this.ddra = v; this.changedA(); return;
      case 0x4: case 0x6: this.t1l = (this.t1l & 0xff00) | v; return;
      case 0x5: this.t1l = (this.t1l & 0xff) | (v << 8); this.t1c = this.t1l; this.ifr &= ~0x40; this.t1run = true; return;
      case 0x7: this.t1l = (this.t1l & 0xff) | (v << 8); this.ifr &= ~0x40; return;
      case 0x8: this.t2l = v; return;
      case 0x9: this.t2c = this.t2l | (v << 8); this.ifr &= ~0x20; this.t2run = true; return;
      case 0xa: this.sr = v; return;
      case 0xb: this.acr = v; return;
      case 0xc: this.pcr = v; this.changedA(); this.changedB(); return;
      case 0xd: this.ifr &= ~v & 0x7f; return;
      case 0xe: if (v & 0x80) this.ier |= v & 0x7f; else this.ier &= ~v & 0x7f; return;
      default: this.ora = v; this.changedA();
    }
  }

  /** Let n cycles pass. Timer 1 runs out after its count plus one; free-running it starts again from the latch. */
  advance(n: number): void {
    this.t1c -= n;
    while (this.t1c < 0) {
      if (this.t1run) { this.ifr |= 0x40; if (!(this.acr & 0x40)) this.t1run = false; }
      this.t1c += this.acr & 0x40 ? this.t1l + 2 : 0x10000;
    }
    this.t2c -= n;
    while (this.t2c < 0) {
      if (this.t2run) { this.ifr |= 0x20; this.t2run = false; }
      this.t2c += 0x10000;
    }
  }

  /** the level on CA1: its active edge (PCR bit 0: rising when set) sets interrupt flag 1 */
  setCa1(level: boolean): void {
    if (level !== this.ca1 && level === ((this.pcr & 0x01) !== 0)) this.ifr |= 0x02;
    this.ca1 = level;
  }

  setCb1(level: boolean): void {
    if (level !== this.cb1 && level === ((this.pcr & 0x10) !== 0)) this.ifr |= 0x10;
    this.cb1 = level;
  }

  save(): ViaState {
    const { ora, orb, ddra, ddrb, t1c, t1l, t2c, t2l, t1run, t2run, acr, pcr, ifr, ier, sr, ca1, cb1 } = this;
    return { ora, orb, ddra, ddrb, t1c, t1l, t2c, t2l, t1run, t2run, acr, pcr, ifr, ier, sr, ca1, cb1 };
  }

  restore(s: ViaState): void { Object.assign(this, s); }
}
