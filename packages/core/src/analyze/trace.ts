/* 5.4 entry points and recursive-descent code tracing, 5.7 forced code; 5.17 tracing a guess on trial */
import type { EntryKind, LogEntry } from '../types';
import { cutKey, forkTrace, type Ctx } from './context';
import { cutFor } from './deep';
import { OPC, type OpcodeInfo } from '../cpu/opcodes';
import { decode } from '../cpu/decode';
import { $4, h2 } from '../util/hex';

/** The program start set by the user, BASIC SYS targets, the first file's load address, user entries and code overrides. */
export function seedEntries(ctx: Ctx): void {
  const { basics, files, ov, project, enqueue, loaded, L } = ctx;
  // a start the user set replaces the detected one; a BASIC stub's SYS target is still code, the load address no longer is
  const userStart = project.entryPoint != null && loaded(project.entryPoint);
  if (userStart) { enqueue(project.entryPoint!, 'entry'); ctx.entry = project.entryPoint!; L('info', `Program start set by you: ${$4(project.entryPoint!)}`, project.entryPoint!, 'entry'); }
  else if (project.entryPoint != null) L('warn', `The program start you set (${$4(project.entryPoint)}) is not in a loaded file; using the detected one`, null, 'entry');
  for (const b of basics) if (b.sys != null) { enqueue(b.sys, 'entry'); ctx.entry = ctx.entry ?? b.sys; }
  // a cartridge starts where its vectors point (5.3b), not at its first byte
  const cart = ctx.cartStart?.entries.filter(e => loaded(e.a)) ?? [];
  for (const e of cart) { enqueue(e.a, e.kind); if (e.kind === 'entry') ctx.entry = ctx.entry ?? e.a; }
  if (files.length && !userStart && !cart.length && !basics.some(b => b.file === 0) && !ov[files[0].load]) {
    // a deep analysis traces the load address on trial, like any guess (`settle`)
    if (ctx.deep) ctx.pending.push({ a: files[0].load, kind: 'entry' });
    else loadEntry(ctx);
  }
  for (const a of project.entries || []) enqueue(a, 'user');
  for (const o of ctx.ovList) if (o.type === 'code') enqueue(o.start, 'user');
}

function loadEntry(ctx: Ctx): void {
  const f = ctx.files[0];
  ctx.enqueue(f.load, 'entry'); ctx.entry = ctx.entry ?? f.load;
  ctx.L('info', `No BASIC stub in ${f.name}; using load address ${$4(f.load)} as entry point`, f.load, 'entry');
}

const BRANCH_ON: Record<string, [string, boolean]> = {
  BCC: ['C', false], BCS: ['C', true], BVC: ['V', false], BVS: ['V', true], BEQ: ['Z', true], BNE: ['Z', false], BMI: ['N', true], BPL: ['N', false],
};

/** The flags a straight run of code has set for sure: each with its value and the instruction that set it. */
type Flags = Partial<Record<'C' | 'V' | 'Z' | 'N', [boolean, number]>>;
const NO_FLAGS = new Set(['STA', 'STX', 'STY', 'SAX', 'PHA', 'PHP', 'SEI', 'CLI', 'SED', 'CLD', 'NOP', 'TXS']);
const NZ_ONLY = new Set(['LDA', 'LDX', 'LDY', 'TAX', 'TAY', 'TXA', 'TYA', 'TSX', 'INX', 'INY', 'DEX', 'DEY', 'INC', 'DEC', 'AND', 'ORA', 'EOR', 'PLA']);

/** The flags after the instruction `o` at `pc` (operand `v`): CLC, SEC and CLV set C and V, a load of a constant Z and N. */
function flagsAfter(f: Flags, o: OpcodeInfo, v: number, pc: number): Flags {
  if (NO_FLAGS.has(o.mn)) return f;
  if (o.mn === 'CLC' || o.mn === 'SEC') return { ...f, C: [o.mn === 'SEC', pc] };
  if (o.mn === 'CLV') return { ...f, V: [false, pc] };
  if (!NZ_ONLY.has(o.mn)) return {};
  const load = o.mode === 'imm' && (o.mn === 'LDA' || o.mn === 'LDX' || o.mn === 'LDY');
  return load ? { C: f.C, V: f.V, Z: [v === 0, pc], N: [v >= 0x80, pc] } : { C: f.C, V: f.V };
}

export function trace(ctx: Ctx): void {
  const { queue, mem, insLen, codeOwner, skip, loaded, forcedData, addX, enqueue, ijumps, inlineCalls, entryKind, flagCut, S, L } = ctx;
  const { deep, cuts } = ctx;
  // a deep analysis does not follow a JSR or JMP into ROM or through an operand that code writes
  const follow = (from: number, to: number) => {
    const why = deep && !insLen[to] && cutFor(deep, loaded, mem, from, to, ctx.onTrial, ctx.cart);
    if (why) cuts.set(cutKey(from, to), why);
    return !why;
  };
  while (queue.length) {
    let pc = queue.pop()!;
    // the flags this run has set, which a deep analysis reads at a branch
    let flags: Flags = {};
    for (;;) {
      if (!loaded(pc)) break;
      if (insLen[pc]) break;
      if (codeOwner[pc] >= 0) {
        const s = codeOwner[pc], op = mem[s];
        if ((op === 0x2c || op === 0x24) && pc === s + 1 && !skip.has(s)) {
          skip.add(s); insLen[s] = 1;
          for (let k = 1; k < OPC[op].len; k++) codeOwner[s + k] = -1;
          L('info', `BIT-skip idiom at ${$4(s)}: $${h2(op)} hides the instruction at ${$4(pc)}`, s, 'code');
        } else {
          L('warn', `Jump into the middle of the instruction at ${$4(s)} (target ${$4(pc)}); overlapping code is not traced`, pc, 'code');
          break;
        }
      }
      if (forcedData(pc)) { L('warn', `Code path runs into user-defined data at ${$4(pc)}`, pc, 'code'); break; }
      const info = OPC[mem[pc]];
      // a deep analysis: code writes the instruction here, BRK or JAM now, so it is set at run time
      if (deep?.written?.[pc] && !ctx.onTrial && (info.jam || info.flow === 'brk')) { L('info', `The code writes the instruction at ${$4(pc)} ($${h2(mem[pc])} now), so it is set at run time and the path stops there`, pc, 'deep'); break; }
      if (info.jam) { L('err', `JAM opcode $${h2(mem[pc])} reached at ${$4(pc)}; the path probably runs into data`, pc, 'code'); break; }
      if (info.ill && !S.illegal) { L('warn', `Undocumented opcode $${h2(mem[pc])} at ${$4(pc)} stops tracing (undocumented opcodes are disabled)`, pc, 'code'); break; }
      let ok = true;
      for (let k = 1; k < info.len; k++) {
        const b = (pc + k) & 0xffff;
        // every byte must be loaded by the same file: an instruction never crosses a file end (spec 7.3)
        if (!loaded(b) || ctx.owner[b] !== ctx.owner[pc] || insLen[b] || codeOwner[b] >= 0 || forcedData(b)) { ok = false; break; }
      }
      if (!ok && (mem[pc] === 0x2c || mem[pc] === 0x24) && insLen[(pc + 1) & 0xffff]) {
        skip.add(pc); insLen[pc] = 1;
        L('info', `BIT-skip idiom at ${$4(pc)}: $${h2(mem[pc])} hides the instruction at ${$4(pc + 1)}`, pc, 'code');
        break;
      }
      if (!ok) { L('warn', `Instruction at ${$4(pc)} would overlap other code or leave the file; tracing stopped`, pc, 'code'); break; }
      insLen[pc] = info.len;
      for (let k = 1; k < info.len; k++) codeOwner[(pc + k) & 0xffff] = pc;
      if (entryKind.has(pc)) flags = {}; // reached some other way too
      const d = decode(mem, pc), next = (pc + info.len) & 0xffff;
      if (info.flow === 'br') {
        addX(d.target!, pc, 'branch');
        // the flags the run set decide (`releaseFlags` takes that back when the run is entered some other way)
        const [f, when] = BRANCH_ON[info.mn], set = deep && d.target !== next ? flags[f as keyof Flags] : undefined;
        const known = set ? set[0] === when : null;
        if (known !== false) enqueue(d.target!, 'branch');
        if (known === true) { flagCut.set(pc, { side: next, by: set![1] }); break; }
        if (known === false) flagCut.set(pc, { side: d.target!, by: set![1] });
        pc = next; continue;
      }
      if (info.flow === 'jmp') { addX(d.target!, pc, 'jump'); if (follow(pc, d.target!)) enqueue(d.target!, 'jmp'); break; }
      if (info.flow === 'jmpi') { addX(d.v!, pc, 'ptr'); ijumps.push({ pc, ptr: d.v! }); break; }
      if (info.flow === 'jsr') {
        addX(d.target!, pc, 'call');
        if (follow(pc, d.target!)) enqueue(d.target!, 'sub');
        if (deep?.noReturn.has(pc)) { cuts.set(cutKey(pc, next), 'noreturn'); break; } // the routine never returns
        const t = d.target!;
        if (loaded(t) && mem[t] === 0x68 && mem[(t + 1) & 0xffff] === 0x85 && mem[(t + 3) & 0xffff] === 0x68) {
          inlineCalls.add(pc);
          L('warn', `JSR ${$4(t)} pops its return address; inline data follows ${$4(next)}`, pc, 'code');
          break;
        }
        flags = {}; pc = next; continue;
      }
      if (info.flow === 'ret') break;
      if (info.flow === 'brk') { L('warn', `BRK at ${$4(pc)} ends the code path`, pc, 'code'); break; }
      if (deep) flags = flagsAfter(flags, info, mem[(pc + 1) & 0xffff], pc);
      pc = next;
    }
  }
}

/**
 * Deep analysis: a branch whose side was left out by the flags before it, where the code from the instruction that
 * set them is reached some other way after all (a jump or branch into it, a BIT-skip byte that runs into it, an entry
 * point), or that instruction or the branch is modified by code: then both sides are followed. Returns whether
 * anything was queued.
 */
export function releaseFlags(ctx: Ctx): boolean {
  const { flagCut, xrefs, entryKind, skip, mem, insLen, queue, ev } = ctx;
  const entered = (a: number) => entryKind.has(a) || (xrefs.get(a) || []).some(x => (x.kind === 'branch' || x.kind === 'jump' || x.kind === 'call') && insLen[x.from])
    || [1, 2, 3].some(k => skip.has((a - k) & 0xffff) && OPC[mem[(a - k) & 0xffff]].len === k);
  let any = false;
  for (const [b, { side, by }] of flagCut) {
    let open = ev.smc.has(by) || ev.smc.has(b);
    for (let a = by, n = 0; !open && a !== b; n++) {
      a = (a + insLen[a]) & 0xffff;
      open = !insLen[a] || n > 64 || entered(a);
    }
    if (!open) continue;
    flagCut.delete(b);
    // a branch target is an entry point as usual; the fall-through is not
    if (side === ((b + 2) & 0xffff)) { if (!insLen[side]) queue.push(side); } else ctx.enqueue(side, 'branch');
    any = true;
  }
  return any;
}

/** What makes a guess traced on trial fail: the trace stops at a problem (but not at inline data after a JSR). */
const fails = (l: LogEntry) => (l.lvl === 'warn' || l.lvl === 'err') && !/pops its return address/.test(l.msg);

/**
 * An indirect JMP goes somewhere known: through a system vector ($0300-$033f, $a000-$a00b, $fff6-$ffff), a pointer code
 * writes, or a pointer table found so far.
 */
function knownPointer(ctx: Ctx, p: number): boolean {
  if ((p >= 0x0300 && p < 0x0340) || (p >= 0xa000 && p < 0xa00c) || p >= 0xfff6) return true;
  const writes = (a: number) => (ctx.xrefs.get(a) || []).some(x => (x.kind === 'write' || x.kind === 'rmw') && ctx.insLen[x.from]) || !!ctx.deep?.written?.[a];
  return writes(p) || writes((p + 1) & 0xffff) || [...ctx.lohiTabs.values()].some(t => t.dest === p) || [...ctx.wordTables.values()].some(t => t.dest === p);
}

/**
 * Deep analysis: trace `a` on trial, with the sides of branches it reaches that the flags left out; the first problem
 * it runs into (an indirect JMP through a pointer nothing sets is one), or null when it runs into none.
 */
export function trial(ctx: Ctx, a: number, kind: EntryKind): LogEntry | null {
  const f = forkTrace(ctx);
  f.enqueue(a, kind, true);
  trace(f);
  while (releaseFlags(f)) trace(f);
  const bad = f.log.find(fails);
  if (bad) return bad;
  const j = f.ijumps.find(j => !knownPointer(ctx, j.ptr));
  return j ? { lvl: 'warn', msg: `Indirect JMP (${$4(j.ptr)}) at ${$4(j.pc)}: target unknown at analysis time`, addr: j.pc, cat: 'code' } : null;
}

/**
 * 5.17 deep analysis: the guesses waiting (code islands, pointer-table targets, interrupt handlers, the load address)
 * are traced on trial, one at a time; a guess is kept and traced when that runs into no problem, else it is left out.
 */
export function settle(ctx: Ctx): void {
  const { pending, rejected } = ctx;
  while (pending.length) {
    const { a, kind } = pending.shift()!;
    if (rejected.has(a)) continue; // the code only grows, so it fails again
    if (!ctx.insLen[a]) {
      const why = trial(ctx, a, kind);
      if (why) { rejected.set(a, { kind, why }); continue; }
    }
    if (kind === 'entry') loadEntry(ctx); else ctx.enqueue(a, kind, true);
    // as on trial, so the next guess is traced on trial against what the code is now
    trace(ctx);
    while (releaseFlags(ctx)) trace(ctx);
  }
}

/** User "mark as code": linear sweep over the override range after tracing. */
export function sweepForcedCode(ctx: Ctx): void {
  const { ovList, insLen, codeOwner, mem, loaded, forcedData } = ctx;
  for (const o of ovList) {
    if (o.type !== 'code') continue;
    let a = o.start;
    while (a < o.end) {
      if (insLen[a]) { a += insLen[a]; continue; }
      const info = OPC[mem[a]];
      // Never start inside an instruction decoded earlier (overlapping code overrides), and leave
      // bytes that a later override turned back into data alone, as tracing does.
      let ok = codeOwner[a] < 0 && !forcedData(a) && loaded(a + info.len - 1) && a + info.len <= o.end;
      for (let k = 1; ok && k < info.len; k++) if (insLen[a + k] || codeOwner[a + k] >= 0 || forcedData(a + k) || ctx.owner[a + k] !== ctx.owner[a]) ok = false;
      if (!ok) break;
      insLen[a] = info.len; for (let k = 1; k < info.len; k++) codeOwner[a + k] = a;
      a += info.len;
    }
  }
}
