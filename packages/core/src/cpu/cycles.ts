/* 6510 cycle counts (NMOS, undocumented opcodes included) and the cycles of one path through a range of code, with
 * the branches the user marks as taken (spec 10.1). */
import type { Addr } from '../types';
import { OPC } from './opcodes';

/** cycles per opcode without a page crossing; branches not taken; 0: JAM halts the CPU */
const CYCLES = [
  7, 6, 0, 8, 3, 3, 5, 5, 3, 2, 2, 2, 4, 4, 6, 6, // 00
  2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 10
  6, 6, 0, 8, 3, 3, 5, 5, 4, 2, 2, 2, 4, 4, 6, 6, // 20
  2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 30
  6, 6, 0, 8, 3, 3, 5, 5, 3, 2, 2, 2, 3, 4, 6, 6, // 40
  2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 50
  6, 6, 0, 8, 3, 3, 5, 5, 4, 2, 2, 2, 5, 4, 6, 6, // 60
  2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 70
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4, // 80
  2, 6, 0, 6, 4, 4, 4, 4, 2, 5, 2, 5, 5, 5, 5, 5, // 90
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4, // a0
  2, 5, 0, 5, 4, 4, 4, 4, 2, 4, 2, 4, 4, 4, 4, 4, // b0
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6, // c0
  2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // d0
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6, // e0
  2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // f0
];

/** reads with an indexed mode (abs,x / abs,y / (zp),y) take one more cycle when the index carries into the next page */
const PAGE = new Set([
  0x11, 0x19, 0x1c, 0x1d, 0x31, 0x39, 0x3c, 0x3d, 0x51, 0x59, 0x5c, 0x5d, 0x71, 0x79, 0x7c, 0x7d,
  0xb1, 0xb3, 0xb9, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xd1, 0xd9, 0xdc, 0xdd, 0xf1, 0xf9, 0xfc, 0xfd,
]);

export interface Cycles {
  /** cycles without a page crossing; a branch: not taken */
  base: number;
  /** one more cycle when the index crosses a page */
  page: boolean;
  /** a branch: cycles when it is taken (3, or 4 when the target is in another page than the next instruction) */
  taken?: number;
  /** JAM: the CPU stops */
  jam?: boolean;
}

/** the target of the branch at `pc` */
export const branchTarget = (mem: Uint8Array, pc: Addr): Addr => (pc + 2 + ((mem[(pc + 1) & 0xffff] ^ 0x80) - 0x80)) & 0xffff;

/** The cycles of the instruction at `pc`, from its opcode and, for branches and indexed reads, its operand. */
export function instructionCycles(mem: Uint8Array, pc: Addr): Cycles {
  const op = mem[pc], o = OPC[op];
  if (o.jam) return { base: 0, page: false, jam: true };
  if (o.flow === 'br') return { base: 2, page: false, taken: ((pc + 2) & 0xff00) === (branchTarget(mem, pc) & 0xff00) ? 3 : 4 };
  // an absolute base whose low byte is $00 cannot carry: $1000,x stays in $10xx
  const page = PAGE.has(op) && !((o.mode === 'abx' || o.mode === 'aby') && mem[(pc + 1) & 0xffff] === 0);
  return { base: CYCLES[op], page };
}

/** `4`, `4+` (one more across a page), `2/3` (a branch: not taken / taken), `—` (JAM) */
export const cycleText = (c: Cycles): string => (c.jam ? '—' : c.taken != null ? `${c.base}/${c.taken}` : `${c.base}${c.page ? '+' : ''}`);

export interface CycleStep {
  pc: Addr;
  cycles: Cycles;
  /** on the path; else a taken branch or jump skips it, or it comes after a return */
  counted: boolean;
  /** the cycles it takes on the path (a taken branch: its taken cycles) */
  used: number;
  /** cycles from the start of the range to the end of this instruction */
  sum: number;
}

export interface CycleBranch {
  pc: Addr;
  target: Addr;
  notTaken: number;
  taken: number;
  /** marked as taken */
  on: boolean;
  /** on the path (a branch that is skipped does not count either way) */
  onPath: boolean;
  /** goes back (a loop) */
  back: boolean;
  /** the target is outside the range */
  leaves: boolean;
  /** the total if this branch went the other way */
  other: number;
  /** a loop: the cycles of one more pass, from the target through this branch taken */
  pass?: number;
}

export interface CyclePath {
  start: Addr;
  end: Addr;
  steps: CycleStep[];
  /** cycles on the path with the marked branches taken */
  total: number;
  /** cycles with no branch taken */
  straight: number;
  /** instructions on the path that can take one more cycle across a page */
  pageMax: number;
  /** calls on the path: their subroutines are not counted */
  calls: number;
  branches: CycleBranch[];
  instructions: number;
}

interface Code { mem: Uint8Array; insLen: Uint8Array }

/** one pass through [start, end): branches in `taken` are taken, jumps followed forward, a return ends the path
 *  (`collect` false: the total only, for the what-if totals of every branch) */
function walk(A: Code, start: Addr, end: Addr, taken: ReadonlySet<Addr>, collect = true): { steps: CycleStep[]; total: number } {
  const steps: CycleStep[] = [];
  let sum = 0, skipTo = -1, stopped = false;
  for (let pc = start; pc < end && pc < 0x10000;) {
    const n = A.insLen[pc];
    if (!n) { pc++; continue; }
    const o = OPC[A.mem[pc]], c = instructionCycles(A.mem, pc);
    const counted = !stopped && pc >= skipTo;
    let used = 0;
    if (counted) {
      const jumpTo = (t: Addr) => { if (t > pc && t < end) skipTo = t; else if (t >= end || t < start) stopped = true; };
      if (c.taken != null && taken.has(pc)) { used = c.taken; const t = branchTarget(A.mem, pc); if (t > pc) jumpTo(t); }
      else used = c.base;
      if (o.flow === 'jmp') { const t = A.mem[(pc + 1) & 0xffff] | (A.mem[(pc + 2) & 0xffff] << 8); if (t === pc) stopped = true; else if (t > pc) jumpTo(t); else stopped = true; }
      if (o.flow === 'ret' || o.flow === 'jmpi' || o.flow === 'brk' || c.jam) stopped = true;
      sum += used;
    }
    if (collect) steps.push({ pc, cycles: c, counted, used, sum });
    pc += n;
  }
  return { steps, total: sum };
}

/**
 * The cycles of the code in [start, end) along one path: from `start`, each instruction once, the branches in
 * `taken` taken (a forward one skips to its target, a loop is not repeated: its `pass` says what one more pass
 * takes), forward jumps followed, a return or a jump out ending the path. Subroutines and page crossings are not
 * added: `calls` and `pageMax` say how many there are.
 */
export function cyclePath(A: Code, start: Addr, end: Addr, taken: ReadonlySet<Addr>): CyclePath {
  const { steps, total } = walk(A, start, end, taken);
  const straight = walk(A, start, end, new Set(), false).total;
  const at = new Map(steps.map((s, i) => [s.pc, i]));
  const branches: CycleBranch[] = [];
  for (const s of steps) {
    if (s.cycles.taken == null) continue;
    const target = branchTarget(A.mem, s.pc), on = taken.has(s.pc), back = target <= s.pc;
    const flipped = new Set(taken); if (on) flipped.delete(s.pc); else flipped.add(s.pc);
    const b: CycleBranch = { pc: s.pc, target, notTaken: s.cycles.base, taken: s.cycles.taken, on, onPath: s.counted, back, leaves: target < start || target >= end, other: walk(A, start, end, flipped, false).total };
    if (back && at.has(target)) {
      let pass = s.cycles.taken;
      for (let i = at.get(target)!; i < at.get(s.pc)!; i++) if (steps[i].counted) pass += steps[i].used;
      b.pass = pass;
    }
    branches.push(b);
  }
  const on = steps.filter(s => s.counted);
  return {
    start, end, steps, total, straight, branches, instructions: on.length,
    pageMax: on.filter(s => s.cycles.page).length,
    calls: on.filter(s => OPC[A.mem[s.pc]].flow === 'jsr').length,
  };
}
