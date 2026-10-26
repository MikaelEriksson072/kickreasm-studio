/* 5.8 SID music detection. A player starts with a jump table: JMP init, then JMP play (up to four JMPs) or the play
 * code right after them, scored by the code its entries reach. That code is decoded from the table where the trace did
 * not get to it, so a player still counts when its init ran before a snapshot was taken or its play is called from an
 * interrupt the trace did not find. Play is the entry the IRQ or the program calls, else the one that writes the most
 * SID registers. A table whose code calls another player's entries is that player's caller, and where tables overlap
 * the strongest wins. */
import type { Ctx } from './context';
import type { Addr, MusicInfo } from '../types';
import { OPC } from '../cpu/opcodes';
import { decode } from '../cpu/decode';
import { $4, word } from '../util/hex';

export type MusicCtx = Pick<Ctx, 'S' | 'mem' | 'insLen' | 'codeOwner' | 'skip' | 'inlineCalls' | 'xrefs' | 'owner' | 'ovList' | 'loaded' | 'forcedData' | 'L' | 'entryKind'>;

/** a player keeps its code together: the table's targets and the code they reach lie this close after it */
const SPAN = 0x2000;
const BEFORE = 0x800;

/** The code reachable from some addresses: the trace's instructions where it decoded them, the rest decoded here. */
interface Reach {
  ins: Map<Addr, number>;
  /** paths that ran into data (a JAM, BRK or unstable opcode, the middle of a traced instruction, a data override) */
  bad: number;
  illegal: number;
  /** instructions the trace had decoded */
  traced: number;
}

interface Slot { at: Addr; to: Addr; jmp: boolean }

/** A jump table that passed the tests: its entries, the code they reach and where that code ends. */
interface Cand { start: Addr; api: Addr[]; play: Addr; sub: Reach; regs: Set<Addr>; sidAt: Addr[]; score: number; why: string[]; hi: Addr }

/**
 * Where note frequency tables start (their high bytes): a run of at least 24 rising bytes, one apart (the low and
 * high bytes in tables of their own) or two (in pairs), in which a byte is about twice the one twelve notes (an
 * octave) before it, at least six times.
 */
export function noteTables(mem: Uint8Array, loaded: (a: Addr) => boolean): { start: Addr; end: Addr }[] {
  const out: { start: Addr; end: Addr }[] = [];
  // along each chain of bytes `step` apart; the starts after a failed one that would stop where it stopped are skipped
  for (const step of [1, 2]) for (let r = 0; r < step; r++) {
    for (let a = r; a + step * 24 < 0x10000;) {
      if (!loaded(a)) { a += step; continue; }
      let n = 1, octaves = 0, next = a + step;
      for (;;) {
        const p = a + step * n;
        if (p >= 0x10000 || !loaded(p) || mem[p] < mem[p - step]) { next = p; break; }
        if (n >= 12) {
          const before = mem[p - 12 * step];
          if (before >= 8) {
            if (Math.abs(mem[p] - 2 * before) > 2 + (before >> 5)) { next = p - 11 * step; break; }
            octaves++;
          }
        }
        n++;
      }
      if (n >= 24 && octaves >= 6) {
        // the zeros a run can start with are not notes
        let start = a;
        while (mem[start] === 0) start += step;
        out.push({ start, end: a + step * n });
        next = a + step * n;
      }
      a = Math.max(a + step, next);
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

export function detectMusic(ctx: MusicCtx): MusicInfo[] {
  const { S, mem, insLen, codeOwner, skip, inlineCalls, xrefs, owner, ovList, loaded, forcedData, L, entryKind } = ctx;
  const music: MusicInfo[] = [];

  const reach = (starts: Addr[], tracedOnly = false): Reach => {
    const ins = new Map<Addr, number>(), stack = [...starts];
    let bad = 0, illegal = 0, traced = 0;
    while (stack.length) {
      const pc = stack.pop()!;
      if (ins.has(pc) || ins.size > 4096 || !loaded(pc)) continue;
      let len = insLen[pc];
      if (len) traced++;
      else if (tracedOnly) continue;
      else {
        const o = OPC[mem[pc]], s = codeOwner[pc];
        // inside an instruction of the trace: only the BIT-skip idiom hides another instruction like that
        if (s >= 0 && !(pc === s + 1 && (mem[s] === 0x2c || mem[s] === 0x24))) { bad++; continue; }
        if (forcedData(pc) || o.jam || o.unstable || o.flow === 'brk' || (o.ill && !S.illegal)) { bad++; continue; }
        let fits = true;
        for (let k = 1; k < o.len; k++) if (!loaded(pc + k) || owner[pc + k] !== owner[pc] || forcedData(pc + k)) fits = false;
        if (!fits) { bad++; continue; }
        len = o.len;
        if (o.ill) illegal++;
      }
      ins.set(pc, len);
      const o = OPC[mem[pc]], d = decode(mem, pc), next = (pc + len) & 0xffff;
      if (skip.has(pc)) { stack.push(next); continue; }
      if (o.flow === 'seq' || o.flow === 'br' || (o.flow === 'jsr' && !inlineCalls.has(pc))) stack.push(next);
      if (o.flow === 'br' || o.flow === 'jmp' || o.flow === 'jsr') stack.push(d.target!);
    }
    return { ins, bad, illegal, traced };
  };
  const reached = new Map<Addr, Reach>();
  const reachOf = (t: Addr) => { let r = reached.get(t); if (!r) reached.set(t, r = reach([t])); return r; };
  const isSidWrite = (pc: Addr) => { const o = OPC[mem[pc]], t = decode(mem, pc).target; return (o.access === 'write' || o.access === 'rmw') && t != null && t >= 0xd400 && t <= 0xd41c; };
  const sidRegs = (r: Reach) => {
    const regs = new Set<Addr>();
    for (const pc of r.ins.keys()) {
      if (!isSidWrite(pc)) continue;
      const o = OPC[mem[pc]], t = decode(mem, pc).target!;
      regs.add(t);
      if (o.mode === 'abx' || o.mode === 'aby') { regs.add(t + 1); regs.add(t + 2); }
    }
    return regs;
  };

  // the code interrupts run: from the handlers the trace found and from the vectors in memory (a snapshot's live ones)
  let irqCode: Set<Addr> | null = null;
  const fromIrq = (from: Addr) => {
    if (!irqCode) {
      const handlers = [...entryKind].filter(([, k]) => k === 'irq' || k === 'nmi').map(([h]) => h);
      for (const v of [0x0314, 0x0318, 0xfffe, 0xfffa]) if (loaded(v) && loaded(v + 1)) handlers.push(word(mem, v));
      irqCode = new Set(reach(handlers, true).ins.keys());
    }
    return irqCode.has(from);
  };
  // JSR and JMP instructions anywhere in memory by target, the ones the trace never decoded too
  let raw: Map<Addr, Addr[]> | null = null;
  const rawRefs = (t: Addr) => {
    if (!raw) {
      raw = new Map();
      for (let p = 0; p < 0xfffd; p++) {
        if ((mem[p] !== 0x20 && mem[p] !== 0x4c) || !loaded(p) || !loaded(p + 2) || codeOwner[p] >= 0) continue;
        const to = word(mem, p + 1);
        let l = raw.get(to); if (!l) raw.set(to, l = []); l.push(p);
      }
    }
    return raw.get(t) || [];
  };

  const notes = noteTables(mem, loaded);
  // traced code reaches the address by a branch or by running on from the instruction before it
  const runInto = (a: Addr) => {
    if (!insLen[a]) return false;
    if ((xrefs.get(a) || []).some(x => x.kind === 'branch')) return true;
    for (let p = Math.max(0, a - 3); p < a; p++) {
      if (insLen[p] && p + insLen[p] === a && !skip.has(p)) { const f = OPC[mem[p]].flow; if (f === 'seq' || f === 'br' || (f === 'jsr' && !inlineCalls.has(p))) return true; }
    }
    return false;
  };

  // every table first, then the players among them
  const cands: Cand[] = [];
  if (S.detectMusic) for (let a = 0; a < 0xfffa; a++) {
    if (mem[a] !== 0x4c || !loaded(a) || !loaded(a + 5) || (!insLen[a] && codeOwner[a] >= 0)) continue;
    // the program's own start is not a player's init
    if (entryKind.get(a) === 'entry') continue;
    const near = (t: Addr) => loaded(t) && owner[t] === owner[a] && t >= a - BEFORE && t < a + SPAN;
    const t0 = word(mem, a + 1);
    if (!near(t0)) continue;
    // JMP init, then JMP play (up to four JMPs), or the play code itself right after them
    const slots: Slot[] = [{ at: a, to: t0, jmp: true }];
    for (let s = a + 3; s <= a + 12; s += 3) {
      if (codeOwner[s] >= 0) break;
      if (s <= a + 9 && mem[s] === 0x4c && loaded(s + 2) && near(word(mem, s + 1))) { slots.push({ at: s, to: word(mem, s + 1), jmp: true }); continue; }
      slots.push({ at: s, to: s, jmp: false });
      break;
    }
    const reaches = slots.map(s => reachOf(s.to));
    // called from outside: from code that is not the player's own (nor a JMP of a table just before this one)
    const own = new Set<Addr>();
    for (const r of reaches) for (const pc of r.ins.keys()) own.add(pc);
    const tableEnd = a + 3 * slots.length;
    const outside = (from: Addr) => (from < a - 12 || from >= tableEnd) && !own.has(from);
    const calls = (at: Addr) => (xrefs.get(at) || []).filter(x => (x.kind === 'call' || x.kind === 'jump') && outside(x.from));
    const rawHit = (at: Addr) => rawRefs(at).some(outside);
    // code right after the JMPs is everywhere: as play it needs a caller or SID writes of its own
    const live = slots.filter((s, i) => s.jmp || calls(s.at).length || rawHit(s.at) || sidRegs(reaches[i]).size >= 4);
    if (live.length < 2) continue;
    // a table is a way in: code the program runs into with nothing calling it is a JMP pair inside other code
    if (runInto(a) && !live.some(s => calls(s.at).length || rawHit(s.at))) continue;

    // play: the entry the IRQ calls, else one the program calls, else one code the trace did not reach calls,
    // else the one that writes the most SID registers (a volume or sound-effect entry writes few)
    const plays = live.slice(1).map(s => {
      const regs = sidRegs(reaches[slots.indexOf(s)]).size, c = calls(s.at);
      const irq = c.some(x => fromIrq(x.from)), raw = !c.length && rawHit(s.at);
      const w = (irq ? 100 : 0) + (c.length ? 20 : 0) + (raw ? 15 : 0) + Math.min(30, 2 * regs) + (s.at === a + 3 ? 1 : 0);
      return { s, regs, irq, called: c.length > 0, raw, w };
    });
    const best = plays.reduce((x, y) => (y.w > x.w ? y : x));
    const play = best.s;
    if (!play.jmp && best.regs === 0) continue;

    const sub = reach(live.filter(s => s.jmp || s === play).map(s => s.to));
    if (sub.ins.size < 4 || sub.bad > 2 || sub.illegal * 8 > sub.ins.size) continue;
    let away = 0;
    for (const pc of sub.ins.keys()) if (pc < a - BEFORE || pc >= a + SPAN) away++;
    if (away > 16) continue;

    let score = 2;
    const why = [play.jmp && play.at === a + 3 ? 'JMP init / JMP play table' : play.jmp ? `JMP init / JMP play table (play at +${play.at - a})` : `JMP init, then the play code at +${play.at - a}`];
    const callsA = calls(a).filter(x => x.kind === 'call').length;
    const callsB = calls(play.at).filter(x => x.kind === 'call').length;
    if (callsA && callsB) { score += 2; why.push('init and play both called from outside'); }
    else if (callsA || callsB) { score += 1; why.push('called from outside'); }
    if ((a & 0xff) === 0) { score += 1; why.push('page aligned'); }
    const regs = sidRegs(sub);
    if (regs.size >= 4) { score += 3; why.push(`writes ${regs.size} SID registers`); }
    else if (regs.size >= 1) score += 1;
    // nothing the trace decoded or called: only the player's own SID writes count
    if (!sub.traced && !callsA && !callsB && regs.size < 4) continue;
    if (best.irq) why.push('play called from the IRQ');
    else if (!best.called && best.raw) why.push('play called from code the trace did not reach');
    if (sub.traced < sub.ins.size) why.push(`${sub.ins.size - sub.traced} instructions decoded from the table (the trace did not reach them)`);

    let hi = tableEnd;
    for (const [pc, len] of sub.ins) hi = Math.max(hi, pc + len);
    for (const pc of sub.ins.keys()) {
      const o = OPC[mem[pc]], d = decode(mem, pc);
      if (o.access && d.target != null && loaded(d.target) && d.target > hi && d.target < a + SPAN) hi = Math.max(hi, d.target + 1);
    }
    // traced code in the range that the table does not reach: a few entries the program calls directly are fine,
    // much of it is other code
    let foreign = 0;
    for (let p = a; p < hi; p++) if (insLen[p] && !sub.ins.has(p) && !skip.has(p)) foreign++;
    if (foreign > 8 && foreign * 4 > sub.ins.size) continue;
    // the note frequency table every tracker player has, read by the code
    const note = notes.find(t => [...sub.ins.keys()].some(pc => {
      const o = OPC[mem[pc]], d = decode(mem, pc);
      return o.access === 'read' && (o.mode === 'abs' || o.mode === 'abx' || o.mode === 'aby') && d.target! >= t.start - 0x20 && d.target! < t.end;
    }));
    if (note) { score += 2; why.push(`note frequency table at ${$4(note.start)}`); }
    // something calls it (traced or not), or it reads notes and starts a page (where players are put): a JMP pair in
    // other code that writes the SID does neither
    const called = live.some(s => calls(s.at).length || rawHit(s.at));
    if (!called && (!note || (a & 0xff) !== 0)) continue;
    if (score < 5) continue;
    // the play code right after a single JMP (the end of one routine and the start of the next, in any code): only
    // with both entries called, or a note table and a caller
    if (!play.jmp && play.at === a + 3 && !(callsA && callsB) && !(note && called)) continue;
    cands.push({ start: a, api: live.map(s => s.at), play: play.at, sub, regs, sidAt: [...sub.ins.keys()].filter(isSidWrite), score, why, hi });
  }

  // a calls b: b's table starts its code (a table inside a player, which a player's own code jumps to, has player code
  // before it), a's code jumps to b's entries from outside b, never runs into b's code any other way, and most of
  // the SID writes it reaches are b's
  const opens = (b: Cand) => { for (const pc of b.sub.ins.keys()) if (pc < b.start) return false; return true; };
  const clientOf = (a: Cand, b: Cand) => {
    if (b.start >= a.start && b.start < a.start + 3 * a.api.length) return false;
    if (!opens(b)) return false;
    let calls = false;
    for (const pc of a.sub.ins.keys()) {
      const inB = pc >= b.start && pc < b.hi;
      if (inB) { if (!b.sub.ins.has(pc)) return false; continue; }
      const o = OPC[mem[pc]];
      if ((o.flow === 'jsr' || o.flow === 'jmp') && b.api.includes(decode(mem, pc).target!)) calls = true;
    }
    return calls && a.sidAt.filter(pc => !b.sub.ins.has(pc)).length < b.sidAt.length;
  };
  const players = cands.filter(a => !cands.some(b => b !== a && clientOf(a, b)));
  // the strongest first; a weaker table inside a player found already, or whose code runs into one, is not a player
  const starts = new Set(players.map(c => c.start));
  const order = [...players].sort((x, y) => y.score - x.score || x.start - y.start);
  for (const c of order) {
    const a = c.start;
    if (music.some(m => a >= m.start && a < m.end)) continue;
    // the code ends where another player's table starts, when that player's code is its own
    let hi = c.hi;
    for (const b of players) if (b.start >= a + 3 * c.api.length && b.start < hi && opens(b) && ![...b.sub.ins.keys()].some(pc => c.sub.ins.has(pc))) hi = b.start;
    if (music.some(m => m.start > a && m.start < hi && [...c.sub.ins.keys()].some(pc => pc >= m.start && pc < m.end))) continue;
    for (const m of music) if (m.start > a && m.start < hi) hi = m.start;
    const refFromOutside = (p: Addr) => (xrefs.get(p) || []).some(x => x.from < a || x.from >= hi);
    // the data after the code, up to other code, bytes the rest of the program uses, a fill or the next player
    let e = hi;
    while (e < 0x10000 && loaded(e) && !insLen[e] && codeOwner[e] < 0 && !refFromOutside(e) && e - a < 0x3000 && !forcedData(e) && !starts.has(e)) {
      let z = 0; while (z < 32 && mem[e + z] === mem[e] && loaded(e + z)) z++;
      if (z >= 32) break;
      e++;
    }
    music.push({ start: a, end: e, init: a, play: c.play, sidRegs: c.regs.size, score: c.score, why: c.why, file: owner[a] });
  }
  music.sort((x, y) => x.start - y.start);
  for (const m of music) L('ok', `Music detected at ${$4(m.start)}-${$4(m.end - 1)} (score ${m.score}: ${m.why.join(', ')})`, m.start, 'music');
  for (const o of ovList) if (o.type === 'music' && !music.some(m => m.start === o.start))
    music.push({ start: o.start, end: o.end, init: o.props?.init ?? o.start, play: o.props?.play ?? o.start + 3, sidRegs: 0, score: 0, why: ['marked by user'], file: owner[o.start], user: true });
  return music;
}
