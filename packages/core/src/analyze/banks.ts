/* 5.8b memory configuration: which $01 configuration and VIC bank each instruction can run with.
 * A dataflow over the traced code (the trace is the first pass). Each register holds the possible
 * values of its bits 0-2 as a mask, so `lda #$35 / sta $01`, `dec $01`, `lda $01 / and #$f8 / ora #$05 /
 * sta $01` and `lda #$3d / sta $dd02` are all followed exactly; anything else makes a register unknown.
 * Subroutines hand their state back to every caller. Interrupt handlers start with what the main code
 * set, narrowed by the vector they were installed through ($0314 needs the KERNAL, $fffe needs it out) and, when
 * they acknowledge their interrupt at VIC or a CIA, to the configurations with I/O. A snapshot's program goes on
 * with the snapshot's $01, from its PC and from its live interrupt vectors.
 * Code under ROM or I/O can only run with RAM there, which narrows the state. BankZones (the user's
 * word) replace the state inside their range and flow on from there. A deep analysis (5.17) also follows values
 * through the stack (`lda $01 / pha … pla / sta $01`) and through variables code only stores to (`lda $01 /
 * sta save … lda save / sta $01`). */
import type { Ctx } from './context';
import type { Addr, MemConfigInfo } from '../types';
import { CLOBBER_A, OPC, SHIFT_MN } from '../cpu/opcodes';
import { decode } from '../cpu/decode';
import { $4 } from '../util/hex';
import { ALL_BANKS, ALL_PORTS, DEFAULT_PORT, bankRange, banksOf, describePorts, ioVisible, portsOf } from '../c64/memconfig';
import { parseVsf, snapshotConfig, type Snapshot } from '../c64/vsf';

const N = 0x10000;
const UNKNOWN = ALL_PORTS;
/** configurations with HIRAM = 0 (the CPU reads $fffa-$ffff from RAM) and with HIRAM = 1 */
const KERNAL_OUT = 0x33, KERNAL_IN = 0xcc;
/** configurations with I/O at $d000-$dfff ($35, $36, $37) */
const IO_IN = 0xe0;
const bit = (v: number) => 1 << (v & 7);
/** f applied to every value (0-7) of a mask */
const each = (m: number, f: (v: number) => number) => { let r = 0; for (let v = 0; v < 8; v++) if (m & (1 << v)) r |= bit(f(v)); return r; };
const eachBank = (m: number, f: (v: number) => number) => { let r = 0; for (let v = 0; v < 8; v++) if (m & (1 << v)) r |= 1 << (f(v) & 3); return r; };
const andMask = (a: number, x: number) => { let r = 0; for (let i = 0; i < 8; i++) if (a & (1 << i)) for (let j = 0; j < 8; j++) if (x & (1 << j)) r |= bit(i & j); return r; };
// the top two values pushed (deep analysis): depth (0-2) | top << 2 | second << 10; nothing is known below them
const depthOf = (st: number) => st & 3, topOf = (st: number) => (st >> 2) & 0xff, secondOf = (st: number) => (st >> 10) & 0xff;
const push = (st: number, m: number) => Math.min(depthOf(st) + 1, 2) | (m << 2) | (topOf(st) << 10);
const pop = (st: number) => depthOf(st) ? (depthOf(st) - 1) | (secondOf(st) << 2) : 0;
const mergeStack = (o: number, n: number) => {
  const d = Math.min(depthOf(o), depthOf(n));
  return d | (d >= 1 ? (topOf(o) | topOf(n)) << 2 : 0) | (d >= 2 ? (secondOf(o) | secondOf(n)) << 10 : 0);
};

export function memConfig(ctx: Ctx): MemConfigInfo {
  const { mem, insLen, skip, entryKind, inlineCalls, project, L, loaded } = ctx;
  const deep = !!ctx.deep;
  const P = new Uint8Array(N), B = new Uint8Array(N), RA = new Uint8Array(N), RX = new Uint8Array(N), RY = new Uint8Array(N), ST = new Int32Array(N);
  const seen = new Uint8Array(N), queued = new Uint8Array(N);
  const forcedPort = new Uint8Array(N), forcedVic = new Uint8Array(N);
  for (const z of project.bankZones || []) {
    for (let a = Math.max(0, z.start); a < z.end && a < N; a++) {
      if (z.port === null) forcedPort[a] = 0; else if (z.port !== undefined) forcedPort[a] = bit(z.port);
      if (z.vicBank === null) forcedVic[a] = 0; else if (z.vicBank !== undefined) forcedVic[a] = 1 << (z.vicBank & 3);
    }
  }
  const code = (a: number) => a >= 0 && a < N && insLen[a] > 0;
  // code only runs where the CPU sees RAM: under the KERNAL it is out, under BASIC that is out, at $d000 all is RAM
  const runnable = (n: number) => n >= 0xe000 ? KERNAL_OUT : n >= 0xd000 ? 0x11 : n >= 0xa000 && n < 0xc000 ? 0x77 : ALL_PORTS;
  // a BIT-skip byte is a 1-byte "instruction" here, but the CPU runs the whole BIT
  const nextOf = (n: number) => (n + (skip.has(n) ? OPC[mem[n]].len : insLen[n])) & 0xffff;
  const work: number[] = [];
  const join = (n: number, p: number, b: number, a: number, x: number, y: number, st = 0) => {
    if (!code(n)) return;
    p = (p & runnable(n)) || runnable(n);
    if (forcedPort[n]) p = forcedPort[n];
    if (forcedVic[n]) b = forcedVic[n];
    const np = P[n] | p, nb = B[n] | b, na = RA[n] | a, nx = RX[n] | x, ny = RY[n] | y, nst = seen[n] ? mergeStack(ST[n], st) : st;
    if (seen[n] && np === P[n] && nb === B[n] && na === RA[n] && nx === RX[n] && ny === RY[n] && nst === ST[n]) return;
    seen[n] = 1; P[n] = np; B[n] = nb; RA[n] = na; RX[n] = nx; RY[n] = ny; ST[n] = nst;
    if (!queued[n]) { queued[n] = 1; work.push(n); }
  };
  // a routine starts with nothing known on the stack, and hands back the caller's (at the JSR before the return)
  const callerStack = (s: Addr) => ST[(s - 3) & 0xffff];
  // deep analysis: the values stored to a variable (zero page or RAM, bits 0-2), none when also changed some other way
  const slot = new Uint8Array(N), readers = new Map<Addr, Set<Addr>>();
  const variable = (at: number) => deep && at >= 2 && (at < 0xd000 || at >= 0xe000);
  const load = (at: number, n: Addr): number => {
    if (!variable(at)) return UNKNOWN;
    let r = readers.get(at); if (!r) readers.set(at, r = new Set()); r.add(n);
    const v = slot[at] | (loaded(at) ? bit(mem[at]) : 0);
    return v || UNKNOWN;
  };
  const store = (at: number, m: number) => {
    if (!variable(at) || (slot[at] | m) === slot[at]) return;
    slot[at] |= m;
    for (const r of readers.get(at) || []) if (seen[r] && !queued[r]) { queued[r] = 1; work.push(r); }
  };

  // the RTS instructions a subroutine can end in (calls inside it are assumed to return)
  const rtsOf = new Map<Addr, Addr[]>();
  let budget = 4_000_000;
  const returnsOf = (t: Addr): Addr[] => {
    let r = rtsOf.get(t);
    if (r) return r;
    rtsOf.set(t, r = []);
    const stack = [t], vis = new Set<number>();
    while (stack.length && budget-- > 0) {
      const n = stack.pop()!;
      if (vis.has(n) || !code(n)) continue;
      vis.add(n);
      if (skip.has(n)) { stack.push(nextOf(n)); continue; }
      const o = OPC[mem[n]];
      switch (o.flow) {
        case 'ret': if (o.mn === 'RTS') r.push(n); break;
        case 'jmp': stack.push(decode(mem, n).target!); break;
        case 'br': stack.push(decode(mem, n).target!, nextOf(n)); break;
        case 'jsr': if (!inlineCalls.has(n)) stack.push(nextOf(n)); break;
        case 'jmpi': case 'brk': case 'jam': break;
        default: stack.push(nextOf(n));
      }
    }
    return r;
  };

  // the handler's code, up to its RTI or a change of $01, writes $d019 or reads $dc0d or $dd0d
  const acknowledges = (h: Addr) => {
    const stack = [h], vis = new Set<number>();
    while (stack.length && vis.size < 2000) {
      const n = stack.pop()!;
      if (vis.has(n) || !code(n)) continue;
      vis.add(n);
      if (skip.has(n)) { stack.push(nextOf(n)); continue; }
      const o = OPC[mem[n]], d = decode(mem, n), at = o.mode === 'abs' ? d.v! : -1;
      if (at === 0xd019 && (o.access === 'write' || o.access === 'rmw')) return true;
      if ((at === 0xdc0d || at === 0xdd0d) && (o.access === 'read' || o.access === 'rmw')) return true;
      if ((o.mode === 'zp' || o.mode === 'abs') && d.v === 1 && (o.access === 'write' || o.access === 'rmw')) continue;
      switch (o.flow) {
        case 'jmp': stack.push(d.target!); break;
        case 'br': stack.push(d.target!, nextOf(n)); break;
        case 'jsr': stack.push(d.target!); if (!inlineCalls.has(n)) stack.push(nextOf(n)); break;
        case 'ret': case 'jmpi': case 'brk': case 'jam': break;
        default: stack.push(nextOf(n));
      }
    }
    return false;
  };

  const retSites = new Map<Addr, Set<Addr>>();
  const changes: MemConfigInfo['changes'] = new Map();
  const run = () => {
    while (work.length) {
      const n = work.pop()!;
      queued[n] = 0;
      let p = P[n], b = B[n], a = RA[n], x = RX[n], y = RY[n], st = ST[n];
      const next = nextOf(n);
      if (skip.has(n)) { join(next, p, b, a, x, y, st); continue; }
      const o = OPC[mem[n]], d = decode(mem, n), mn = o.mn, mode = o.mode;
      const at = mode === 'zp' || mode === 'abs' ? d.v! : -1;
      const port = at === 1;
      switch (mn) {
        case 'LDA': a = mode === 'imm' ? bit(d.v!) : port ? p : load(at, n); break;
        case 'LDX': x = mode === 'imm' ? bit(d.v!) : port ? p : load(at, n); break;
        case 'LDY': y = mode === 'imm' ? bit(d.v!) : port ? p : load(at, n); break;
        case 'PHA': case 'PHP': if (deep) st = push(st, mn === 'PHA' ? a : UNKNOWN); break;
        case 'PLA': a = deep && depthOf(st) ? topOf(st) : UNKNOWN; st = pop(st); break;
        case 'PLP': st = pop(st); break;
        case 'TXS': st = 0; break;
        case 'TAX': x = a; break;
        case 'TAY': y = a; break;
        case 'TXA': a = x; break;
        case 'TYA': a = y; break;
        case 'INX': x = each(x, v => v + 1); break;
        case 'DEX': x = each(x, v => v + 7); break;
        case 'INY': y = each(y, v => v + 1); break;
        case 'DEY': y = each(y, v => v + 7); break;
        case 'AND': case 'ORA': case 'EOR': {
          const k = d.v!;
          a = mode !== 'imm' ? UNKNOWN : each(a, v => mn === 'AND' ? v & k : mn === 'ORA' ? v | k : v ^ k);
          break;
        }
        case 'STA': case 'STX': case 'STY': case 'SAX': {
          if (at < 0) break; // indexed and indirect stores are not followed
          const r = mn === 'STA' ? a : mn === 'STX' ? x : mn === 'STY' ? y : andMask(a, x);
          if (port) { p = r; changes.set(n, { port: p, via: '$01' }); }
          else if (variable(at)) store(at, r);
          else if ((at & 0xff0f) === 0xdd00 || (at & 0xff0f) === 0xdd02) {
            // a store to $dd00/$dd02 only reaches CIA 2 where I/O is visible
            const io = ioVisible(p);
            if (io !== 'none') {
              // $dd00 bits 0-1 select bank 3-n; the $dd02 trick turns those bits into inputs (read as 1) over a latch of 0
              const dd00 = (at & 0xf) === 0;
              const nb = eachBank(r, dd00 ? v => 3 - (v & 3) : v => v & 3);
              b = io === 'all' ? nb : b | nb;
              changes.set(n, { vic: b, via: dd00 ? '$dd00' : '$dd02' });
            }
          }
          break;
        }
        case 'INC': case 'DEC':
          if (port) { p = each(p, v => v + (mn === 'INC' ? 1 : 7)); changes.set(n, { port: p, via: '$01' }); }
          else if (at >= 0) store(at, UNKNOWN);
          break;
        default:
          if (port && o.access === 'rmw') { p = UNKNOWN; changes.set(n, { port: p, via: '$01' }); }
          else if (at >= 0 && o.access === 'rmw') store(at, UNKNOWN);
          if (CLOBBER_A.has(mn) || (SHIFT_MN.has(mn) && mode === 'acc')) a = UNKNOWN;
          if (mn === 'TSX' || mn === 'AXS' || mn === 'LAS' || mn === 'LAX') x = UNKNOWN;
      }
      switch (o.flow) {
        case 'br': join(d.target!, p, b, a, x, y, st); join(next, p, b, a, x, y, st); break;
        case 'jmp': join(d.target!, p, b, a, x, y, st); break;
        case 'jsr': {
          const t = d.target!;
          join(t, p, b, a, x, y);
          if (inlineCalls.has(n)) break; // the routine reads data after the call and jumps past it
          if (!code(t)) { join(next, p, b, UNKNOWN, UNKNOWN, UNKNOWN, st); break; } // KERNAL or code outside the files
          const rs = returnsOf(t);
          if (!rs.length) join(next, p, b, UNKNOWN, UNKNOWN, UNKNOWN, st);
          for (const r of rs) {
            let s = retSites.get(r);
            if (!s) retSites.set(r, s = new Set());
            if (!s.has(next)) { s.add(next); if (seen[r]) join(next, P[r], B[r], RA[r], RX[r], RY[r], st); }
          }
          break;
        }
        case 'ret': if (mn === 'RTS') for (const s of retSites.get(n) || []) join(s, p, b, a, x, y, callerStack(s)); break;
        case 'jmpi': case 'brk': case 'jam': break;
        default: join(next, p, b, a, x, y, st);
      }
    }
  };
  const seed = (n: Addr, p: number, b: number) => join(n, p, b, UNKNOWN, UNKNOWN, UNKNOWN);

  // a snapshot's program was running with the $01 the snapshot holds (at its PC too); a program starts with $37
  let snap: Snapshot | null = null;
  for (const f of ctx.files) if (!snap && f.vsf) try { snap = parseVsf(f.vsf); } catch { /* not readable: a plain start */ }
  const startPort = snap ? bit(snapshotConfig(snap)) : bit(DEFAULT_PORT);
  // ... and VIC bank 0
  for (const [a, k] of entryKind) if (k === 'entry') seed(a, startPort, 1);
  if (snap?.cpu) seed(snap.cpu.pc, startPort, 1);
  run();
  let mainP = 0, mainB = 0;
  for (let a = 0; a < N; a++) if (seen[a]) { mainP |= P[a]; mainB |= B[a]; }
  if (!mainP) { mainP = bit(DEFAULT_PORT); mainB = 1; }
  // the handlers the trace found, with the vectors they were installed through, and a snapshot's live ones
  const handlers = new Map<Addr, Set<Addr>>();
  for (const [a, k] of entryKind) if (k === 'irq' || k === 'nmi' || k === 'brk') handlers.set(a, new Set(ctx.ev.vectors.get(a) || []));
  if (snap) for (const v of snapshotConfig(snap) & 2 ? [0x0314, 0x0318] : [0xfffe, 0xfffa]) {
    const h = snap.ram[v] | (snap.ram[v + 1] << 8);
    if (code(h)) { const s = handlers.get(h) ?? new Set<Addr>(); s.add(v); handlers.set(h, s); }
  }
  for (const [a, vectors] of handlers) {
    let vm = 0;
    for (const v of vectors) vm |= v >= 0xff00 ? KERNAL_OUT : KERNAL_IN;
    let p = vm ? (mainP & vm) || vm : mainP;
    // a handler that acknowledges its interrupt at VIC or a CIA sees I/O: else the interrupt would fire again at once
    if (acknowledges(a)) p = (p & IO_IN) || ((vm || ALL_PORTS) & IO_IN) || p;
    seed(a, p, mainB);
  }
  run();
  // the rest the trace found (user entries, pointer and jump-table targets, code overrides): the main code's state
  for (const [a, k] of entryKind) if (!seen[a] && k !== 'branch' && k !== 'jmp') seed(a, mainP, mainB);
  run();
  for (let a = 0; a < N; a++) if (code(a) && !seen[a]) { seed(a, mainP, mainB); run(); }

  for (const [pc, c] of [...changes].sort((u, v) => u[0] - v[0])) {
    if (c.port != null) {
      if (c.port === ALL_PORTS) L('hint', `$01 is written at ${$4(pc)} with a value the analysis cannot follow. Select the code that runs afterwards and set its memory configuration (right-click → Memory configuration).`, pc, 'memory');
      else L('info', portsOf(c.port).length === 1 ? `$01 = ${describePorts(c.port)} from ${$4(pc)}` : `$01 is ${describePorts(c.port)} after ${$4(pc)}`, pc, 'memory');
    } else if (c.vic != null && c.vic !== ALL_BANKS) {
      const bs = banksOf(c.vic);
      L('info', `VIC bank ${bs.join(' or ')} (${bs.map(bankRange).join(', ')}) selected via ${c.via} at ${$4(pc)}${c.via === '$dd02' ? ', assuming $dd00 bits 0-1 are 0' : ''}`, pc, 'memory');
    }
  }
  return { port: P, vic: B, changes, forcedPort, forcedVic };
}
