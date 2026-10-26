/* 5.16 raster interrupts: every IRQ handler with the raster line it runs at. A pass over the traced code in straight
 * runs (like the evidence pass, 5.5) follows what A, X and Y hold bit by bit, so `lda $d011 / and #$7f / sta $d011`
 * still says that bit 8 of the line is 0. Where a run sets an IRQ vector to a handler, the $d012 and $d011 writes of
 * that run are the line it runs at; a handler that writes $d012 without setting the vector runs again at that line.
 * The handlers are the trace's IRQ entries and, in a VICE snapshot, the one its IRQ vector points at. */
import type { Ctx } from './context';
import type { Addr, RasterIrq } from '../types';
import { CLOBBER_A, OPC, SHIFT_MN } from '../cpu/opcodes';
import { decode } from '../cpu/decode';
import { parseVsf, snapshotConfig } from '../c64/vsf';

/** what a register holds: the bits in `m` are known to be as in `v` */
interface Bits { v: number; m: number }
interface Write { pc: Addr; dest: Addr; r: Bits | null }

const IRQ_VECTORS: Record<number, Addr> = { 0x0314: 0x0315, 0xfffe: 0xffff };
const known = (r: Bits | null) => !!r && r.m === 0xff;

export function rasterIrqs(ctx: Ctx): RasterIrq[] {
  const { mem, insLen, xrefs, entryKind, inlineCalls, skip, loaded } = ctx;

  // the straight runs of traced code and the stores in them
  const runs: Write[][] = [];
  let run: Write[] = [], A: Bits | null = null, X: Bits | null = null, Y: Bits | null = null, prevEnd = -1, prevBreak = true;
  const reset = () => { if (run.length) runs.push(run); run = []; A = X = Y = null; };
  for (let pc = 0; pc < 0x10000; pc++) {
    if (!insLen[pc]) continue;
    const target = entryKind.has(pc) || (xrefs.get(pc) || []).some(x => x.kind === 'branch' || x.kind === 'jump' || x.kind === 'call');
    if (pc !== prevEnd || prevBreak || target) reset();
    const o = OPC[mem[pc]], d = decode(mem, pc), mn = o.mn, imm = o.mode === 'imm';
    prevEnd = (pc + insLen[pc]) & 0xffff;
    prevBreak = o.flow === 'jmp' || o.flow === 'jmpi' || o.flow === 'ret' || o.flow === 'brk' || inlineCalls.has(pc);
    if (skip.has(pc)) { reset(); continue; }
    const a = (): Bits | null => A, x = (): Bits | null => X, y = (): Bits | null => Y;
    const step = (r: Bits | null, n: number) => (known(r) ? { v: (r!.v + n) & 0xff, m: 0xff } : null);
    switch (mn) {
      case 'LDA': A = imm ? { v: d.v!, m: 0xff } : null; break;
      case 'LDX': X = imm ? { v: d.v!, m: 0xff } : null; break;
      case 'LDY': Y = imm ? { v: d.v!, m: 0xff } : null; break;
      case 'TAX': X = a(); break;
      case 'TAY': Y = a(); break;
      case 'TXA': A = x(); break;
      case 'TYA': A = y(); break;
      case 'INX': X = step(x(), 1); break;
      case 'DEX': X = step(x(), -1); break;
      case 'INY': Y = step(y(), 1); break;
      case 'DEY': Y = step(y(), -1); break;
      case 'AND': { const r = a(); A = imm ? { v: (r?.v ?? 0) & d.v!, m: ((r?.m ?? 0) | ~d.v!) & 0xff } : null; break; }
      case 'ORA': { const r = a(); A = imm ? { v: (r?.v ?? 0) | d.v!, m: ((r?.m ?? 0) | d.v!) & 0xff } : null; break; }
      case 'EOR': { const r = a(); A = imm && r ? { v: r.v ^ d.v!, m: r.m } : null; break; }
      case 'STA': case 'STX': case 'STY':
        if (o.mode === 'abs' || o.mode === 'zp') run.push({ pc, dest: d.target!, r: mn === 'STA' ? a() : mn === 'STX' ? x() : y() });
        break;
      case 'JSR': A = X = Y = null; break;
      default:
        if (CLOBBER_A.has(mn) || (SHIFT_MN.has(mn) && o.mode === 'acc')) A = null;
        if (mn === 'TSX' || mn === 'AXS' || mn === 'LAS' || mn === 'LAX') X = null;
        if (mn === 'LAX') A = null;
    }
  }
  reset();

  // the code each handler runs, to tell whose code a run is (a raster chain sets the next handler)
  const handlers = [...entryKind].filter(([, k]) => k === 'irq').map(([h]) => h);
  // and in a snapshot the one its vector points at, also when the code that set it was not traced
  for (const f of ctx.files) {
    if (!f.vsf) continue;
    try {
      const s = parseVsf(f.vsf), v = snapshotConfig(s) & 2 ? 0x0314 : 0xfffe, h = s.ram[v] | (s.ram[v + 1] << 8);
      if (insLen[h] && !handlers.includes(h)) handlers.push(h);
    } catch { /* not readable */ }
  }
  handlers.sort((p, q) => p - q);
  const reachOf = new Map<Addr, Set<Addr>>();
  for (const h of handlers) {
    const seen = new Set<Addr>(), stack = [h];
    while (stack.length && seen.size < 8192) {
      const pc = stack.pop()!;
      if (seen.has(pc) || !insLen[pc] || !loaded(pc)) continue;
      seen.add(pc);
      const o = OPC[mem[pc]], d = decode(mem, pc), next = (pc + insLen[pc]) & 0xffff;
      if (skip.has(pc)) { stack.push(next); continue; }
      if (o.flow === 'seq' || o.flow === 'br' || (o.flow === 'jsr' && !inlineCalls.has(pc))) stack.push(next);
      if (o.flow === 'br' || o.flow === 'jmp' || o.flow === 'jsr') stack.push(d.target!);
    }
    reachOf.set(h, seen);
  }
  const ownersOf = (pc: Addr) => handlers.filter(h => reachOf.get(h)!.has(pc));

  const out: RasterIrq[] = [];
  const add = (r: RasterIrq) => { if (!out.some(o => o.handler === r.handler && o.setAt === r.setAt && o.installedAt === r.installedAt)) out.push(r); };
  for (const ws of runs) {
    const d012 = ws.filter(w => w.dest === 0xd012), d011 = ws.filter(w => w.dest === 0xd011);
    const nearest = (l: Write[], pc: Addr) => l.reduce<Write | null>((b, w) => (!b || Math.abs(w.pc - pc) < Math.abs(b.pc - pc) ? w : b), null);
    const line = (at: Addr): Pick<RasterIrq, 'line' | 'd012' | 'd011' | 'setAt'> => {
      const lo = nearest(d012, at), hi = nearest(d011, at);
      const v = lo && known(lo.r) ? lo.r!.v : null;
      const bit8 = hi && hi.r && hi.r.m & 0x80 ? (hi.r.v >> 7) & 1 : null;
      return {
        d012: v, setAt: lo ? lo.pc : null,
        d011: hi ? { value: known(hi.r) ? hi.r!.v : null, bit8: bit8 as 0 | 1 | null, at: hi.pc } : null,
        line: v == null ? null : v + (bit8 === 1 ? 256 : 0),
      };
    };
    const from = (pc: Addr) => ownersOf(pc)[0] ?? null;
    // IRQ vectors this run sets: both bytes as constants, the low byte's store gives where
    let installs = 0;
    for (const lo of ws) {
      const hiAddr = IRQ_VECTORS[lo.dest];
      if (hiAddr == null || !known(lo.r)) continue;
      const hi = ws.find(w => w.dest === hiAddr && known(w.r));
      if (!hi) continue;
      const h = lo.r!.v | (hi.r!.v << 8);
      if (!loaded(h)) continue;
      installs++;
      add({ handler: h, vector: lo.dest, installedAt: lo.pc, from: from(lo.pc), ...line(lo.pc) });
    }
    // a handler that only writes $d012 runs again at that line
    if (!installs && d012.length) {
      const owners = ownersOf(d012[0].pc);
      if (owners.length === 1) add({ handler: owners[0], vector: null, installedAt: null, from: owners[0], ...line(d012[0].pc) });
    }
  }
  // the handlers no line was found for (a timer interrupt, a vector set from a table)
  for (const h of handlers) if (!out.some(r => r.handler === h)) out.push({ handler: h, vector: null, installedAt: null, from: null, line: null, d012: null, d011: null, setAt: null });
  return out.sort((p, q) => (p.line ?? 0x10000) - (q.line ?? 0x10000) || p.handler - q.handler);
}
