/* =====================================================================
 * 5.17 deep analysis (Settings.deepAnalysis): re-analyses until the problems are at a minimum.
 * Every round is a whole analysis. Inside one, a guess (a code island, a pointer-table target, an interrupt
 * handler, the load address without a BASIC stub) is traced on trial first and kept only when it runs into no
 * problem (`settle`), and a branch whose flags the instruction before it sets follows only the side it takes.
 * What a round learns, the next one uses while it traces: the $01 configuration of every instruction (a JSR or
 * JMP into ROM is not followed into the RAM below), the bytes code writes (a JSR or JMP whose operand is written
 * has its target set at run time, and a path stops quietly at an instruction code writes that is BRK or JAM now) and
 * the routines that never return (the bytes after a JSR to one are not code). A JSR or JMP to a BRK or JAM is not
 * followed either: the routine is put there at run time. The rounds end when the next one would decide the same; the result is the deep one unless the normal
 * analysis has fewer problems.
 * ===================================================================== */
import type { Addr, AnalysisResult, EntryKind, LogEntry } from '../types';
import { cutKey, type Ctx, type CutWhy, type Deep } from './context';
import { OPC } from '../cpu/opcodes';
import { decode } from '../cpu/decode';
import { areaAt, banked, portsOf, reaches } from '../c64/memconfig';
import { $4 } from '../util/hex';

/** What the Problems tab lists from the log. */
export const isProblem = (l: LogEntry): boolean => l.lvl === 'warn' || l.lvl === 'err' || l.lvl === 'hint';
export const problemCount = (log: LogEntry[]): number => log.filter(isProblem).length;

/**
 * Why the JSR or JMP at `pc` to `t` is not followed, by what the round before learned; null: it is. `guess`: the code
 * is a guess traced on trial, which a routine that is not there yet does not excuse.
 */
export function cutFor(deep: Deep, loaded: (a: Addr) => boolean, mem: Uint8Array, pc: Addr, t: Addr, guess = false): CutWhy | null {
  if (deep.written && (deep.written[(pc + 1) & 0xffff] || deep.written[(pc + 2) & 0xffff])) return 'smc';
  // ROM (or I/O) in every configuration the instruction can run with; new code runs with the main code's
  if (deep.main && loaded(t) && banked(t) && reaches(t, deep.port?.[pc] || deep.main, false) === 'hw') return 'rom';
  // no routine starts with BRK or JAM: the code there is put in place at run time (unpacked or copied)
  if (!guess && loaded(t) && (mem[t] === 0x00 || OPC[mem[t]].jam)) return 'empty';
  return null;
}

/** Does the routine at `t` never return: every path in the traced code ends in a loop, without RTS, RTI or JMP (ind)? */
function neverReturns(A: AnalysisResult, cuts: Map<number, CutWhy>, t: Addr): boolean {
  const { mem, insLen, skip, inlineCalls } = A;
  const stack = [t], vis = new Set<number>();
  while (stack.length) {
    const n = stack.pop()!;
    if (vis.has(n)) continue;
    if (vis.size > 4000 || !insLen[n]) return false; // too far, or out of the traced code: it may return
    vis.add(n);
    const o = OPC[mem[n]], next = (n + o.len) & 0xffff;
    if (skip.has(n)) { stack.push(next); continue; }
    const d = decode(mem, n);
    switch (o.flow) {
      case 'jmp': if (cuts.has(cutKey(n, d.target!))) return false; stack.push(d.target!); break; // into ROM: a tail call
      case 'br': stack.push(d.target!, next); break;
      case 'jsr': if (inlineCalls.has(n)) return false; if (cuts.get(cutKey(n, next)) !== 'noreturn') stack.push(next); break;
      case 'ret': case 'jmpi': case 'brk': case 'jam': return false;
      default: stack.push(next);
    }
  }
  return true;
}

/**
 * What round `A` teaches the next one, into `deep`. Returns whether the next round can decide differently: on this
 * round's code, or in the configuration that new code is assumed to run with.
 */
export function learn(A: AnalysisResult, ctx: Ctx, deep: Deep): boolean {
  const { mem, insLen, skip, xrefs, mcfg, owner, inlineCalls } = A;
  const port = mcfg?.port ?? null;
  // code under ROM or I/O only runs with RAM there: the main code is the rest
  let main = 0;
  if (port) for (let a = 0; a < 0x10000; a++) if (insLen[a] && !banked(a)) main |= port[a];
  const written = new Uint8Array(0x10000);
  for (const [to, xs] of xrefs) if (xs.some(x => (x.kind === 'write' || x.kind === 'rmw') && insLen[x.from])) written[to] = 1;
  const next: Deep = { port, main, written, noReturn: new Set() };
  const loaded = (a: Addr) => owner[a] >= 0;
  const would = new Map<number, CutWhy>();
  const calls: Addr[] = [];
  for (let pc = 0; pc < 0x10000; pc++) {
    if (!insLen[pc] || skip.has(pc)) continue;
    const o = OPC[mem[pc]];
    if ((o.flow !== 'jsr' && o.flow !== 'jmp') || o.mode !== 'abs') continue;
    const t = decode(mem, pc).target!, why = cutFor(next, loaded, mem, pc, t);
    if (why) would.set(cutKey(pc, t), why);
    else if (o.flow === 'jsr' && !inlineCalls.has(pc) && insLen[t]) calls.push(pc);
  }
  for (const pc of calls) {
    if (!neverReturns(A, would, decode(mem, pc).target!)) continue;
    next.noReturn.add(pc);
    would.set(cutKey(pc, pc + 3), 'noreturn');
  }
  const same = would.size === ctx.cuts.size && [...would].every(([k, w]) => ctx.cuts.get(k) === w);
  const changed = !same || main !== deep.main;
  Object.assign(deep, next);
  return changed;
}

const AREA = { kernal: 'KERNAL ROM', basic: 'BASIC ROM', io: 'I/O', char: 'character ROM', ram: 'RAM' } as const;
const list = (as: Addr[]) => as.slice(0, 4).map($4).join(', ') + (as.length > 4 ? ', …' : '');
const KIND: Partial<Record<EntryKind, string>> = { ptr: 'pointer-table target', irq: 'IRQ handler', nmi: 'NMI handler', brk: 'BRK handler' };

/** The log lines of a deep analysis: what it did not follow and left out, and a summary (and `A.deep`). */
export function deepLog(A: AnalysisResult, ctx: Ctx, before: number, rounds: number): void {
  const { mem, mcfg, xrefs, insLen } = A;
  const L = (lvl: LogEntry['lvl'], msg: string, addr: Addr | null) => A.log.push({ lvl, msg, addr, cat: 'deep' });
  const rom = new Map<Addr, Addr[]>();
  for (const [k, why] of [...ctx.cuts].sort((x, y) => x[0] - y[0])) {
    const from = Math.floor(k / 0x10000), to = k & 0xffff, mn = OPC[mem[from]].mn;
    if (why === 'rom') { const s = rom.get(to) ?? []; s.push(from); rom.set(to, s); continue; }
    if (why === 'noreturn') { L('info', `The routine at ${$4(decode(mem, from).target!)} never returns, so the bytes after the JSR at ${$4(from)} are not traced`, from); continue; }
    if (why === 'empty') { L('info', `The ${mn} at ${$4(from)} goes to ${$4(to)}, which holds $${mem[to].toString(16).padStart(2, '0')}: the routine is put there at run time (unpacked or copied), so it is not traced`, from); continue; }
    const by = [from + 1, from + 2].flatMap(a => xrefs.get(a & 0xffff) || []).find(x => (x.kind === 'write' || x.kind === 'rmw') && insLen[x.from]);
    L('info', `${by ? `The code at ${$4(by.from)}` : 'Code'} writes the address of the ${mn} at ${$4(from)}, so its target ${$4(to)} is set at run time and is not followed`, from);
  }
  for (const [t, from] of rom) {
    const area = mcfg ? AREA[areaAt(t, portsOf(mcfg.port[from[0]])[0] ?? 7, false)] : 'ROM';
    L('info', `${from.length === 1 ? `The ${OPC[mem[from[0]]].mn} at ${$4(from[0])}` : `${from.length} calls and jumps (at ${list(from)})`} to ${$4(t)} reach${from.length === 1 ? 'es' : ''} the ${area} there, so the RAM below it is not traced`, from[0]);
  }
  // one line per data block: the first start left out in it, and how many more
  let rejected = 0;
  const groups = new Map<string, { a: Addr; kind: EntryKind; why: LogEntry; more: number; end: Addr }>();
  for (const [a, { kind, why }] of [...ctx.rejected].sort((x, y) => x[0] - y[0])) {
    if (insLen[a]) continue; // code after all, reached some other way
    rejected++;
    const b = kind === 'guess' ? A.blocks.find(x => a >= x.start && a < x.end) : undefined;
    const key = kind + (b ? b.start : a);
    const g = groups.get(key);
    if (g) { g.more++; g.end = a; } else groups.set(key, { a, kind, why, more: 0, end: a });
  }
  for (const { a, kind, why, more, end } of groups.values()) {
    const what = kind === 'entry' ? `The load address ${$4(a)} is not used as the entry point`
      : kind === 'guess' ? `The routine-like bytes at ${$4(a)}${more ? ` (and ${more} more start${more === 1 ? '' : 's'} up to ${$4(end)})` : ''} stay data`
        : `The ${KIND[kind]} at ${$4(a)} stays data`;
    L('info', `${what}: traced on trial, ${kind === 'guess' ? 'they run' : 'it runs'} into a problem (${why.msg.replace(/[.;].*$/, '')})`, a);
  }
  const after = problemCount(A.log), cuts = ctx.cuts.size, branches = ctx.flagCut.size;
  A.deep = { rounds, before, after, rejected, cuts, branches, ms: 0 };
  const s = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  L('ok', `Deep analysis: ${before} → ${s(after, 'problem')} in ${s(rounds, 'round')}: ${s(rejected, 'guess', 'guesses')} left out, ${s(cuts, 'call or jump', 'calls and jumps')} not followed, ${s(branches, 'branch', 'branches')} decided by the flags before ${branches === 1 ? 'it' : 'them'}`, null);
}
