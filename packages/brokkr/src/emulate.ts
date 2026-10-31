/* A C64 just big enough to run a decruncher and check it: 64 KB of RAM, the CPU port at $00/$01 banking BASIC,
 * KERNAL, I/O and the character ROM in and out, and nothing behind the ROMs and I/O but traps. A decruncher that
 * reads RAM under a ROM that is still in, or writes to I/O other than the border, is caught: Brokkr runs every
 * self-extracting file it makes through this before it hands it over. */
import { Cpu, type Bus } from './cpu.ts';

export interface Trouble { pc: number; addr: number; what: string }

export class Machine implements Bus {
  readonly ram = new Uint8Array(0x10000);
  ddr = 0x2f;
  port = 0x37;
  readonly cpu: Cpu;
  cycles = 0;
  /** the first things that went wrong: reads from a ROM over RAM, writes to I/O */
  readonly trouble: Trouble[] = [];
  /** writes to the border colour ($d020), the decrunch effect */
  border = 0;

  constructor() { this.cpu = new Cpu(this); }

  private note(addr: number, what: string): void {
    if (this.trouble.length < 8) this.trouble.push({ pc: this.cpu.pc, addr, what });
  }

  /** what is at an address for the CPU: 'ram', 'basic', 'kernal', 'io' or 'char' */
  view(addr: number): 'ram' | 'basic' | 'kernal' | 'io' | 'char' {
    const p = this.port & 7;
    if (addr >= 0xa000 && addr < 0xc000 && (p & 3) === 3) return 'basic';
    if (addr >= 0xe000 && (p & 2)) return 'kernal';
    if (addr >= 0xd000 && addr < 0xe000 && (p & 3)) return p & 4 ? 'io' : 'char';
    return 'ram';
  }

  read(addr: number): number {
    if (addr === 0) return this.ddr;
    if (addr === 1) return this.port;
    const v = this.view(addr);
    if (v === 'ram') return this.ram[addr];
    if (v === 'io' && addr === 0xd020) return this.border | 0xf0;
    this.note(addr, `read ${v === 'io' ? 'I/O' : v === 'char' ? 'the character ROM' : `the ${v.toUpperCase()} ROM`} instead of RAM`);
    return 0;
  }

  fetch(addr: number): number {
    const v = this.view(addr);
    if (v !== 'ram') { this.note(addr, `ran code in ${v === 'io' ? 'I/O' : `the ${v} ROM`}`); return 0x02; }
    return this.ram[addr];
  }

  write(addr: number, value: number): void {
    if (addr === 0) { this.ddr = value; return; }
    if (addr === 1) { this.port = value; return; }
    const v = this.view(addr);
    if (v === 'io') {
      if (addr === 0xd020) { this.border = value & 0x0f; return; }
      this.note(addr, 'wrote to I/O');
      return;
    }
    this.ram[addr] = value;
  }

  /** Run from `pc` until `until(pc)` is true before an instruction, or the budget runs out; the cycles used. */
  run(pc: number, until: (pc: number) => boolean, budget: number): { stopped: boolean; cycles: number } {
    const cpu = this.cpu;
    cpu.pc = pc;
    const start = this.cycles;
    while (this.cycles - start < budget) {
      if (until(cpu.pc)) return { stopped: true, cycles: this.cycles - start };
      if (cpu.jammed) break;
      this.cycles += cpu.step();
    }
    return { stopped: false, cycles: this.cycles - start };
  }
}
