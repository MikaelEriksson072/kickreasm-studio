/* 5.4b timing code: a branch the code points into a delay by a timer, to make a raster stable.
 * `lda $dc06 / eor #$07 / sta bpl+1 / bpl * / lda #$a9 / lda #$a9 / lda $eaa5` waits 8 down to 0 cycles by where
 * CIA 1's timer B stood: the branch enters the 7 bytes after it 0-7 bytes in, and each way in decodes to
 * instructions that end where the delay ends. A timer is CIA 1 or 2's timer A or B ($dc04-$dc07, $dd04-$dd07) or the
 * VIC's raster ($d012); the most the branch skips is the AND or EOR before the store. The delay is decoded from its
 * start (a snapshot may hold another way in), its operands only take time (they get no labels), and the listing and
 * the source mark it. */
import type { Addr, DelaySled } from '../types';
import type { Ctx } from './context';
import { CLOBBER_A, OPC, SHIFT_MN } from '../cpu/opcodes';
import { decode } from '../cpu/decode';
import { instructionCycles } from '../cpu/cycles';
import { hwSymbol } from '../c64/symbols';
import { $4 } from '../util/hex';

/** a register that counts: the CIAs' timers (mirrored every $10) and the VIC's raster (every $40) */
const counts = (t: Addr) => ((t & 0xff0f) >= 0xdc04 && (t & 0xff0f) <= 0xdc07) || ((t & 0xff0f) >= 0xdd04 && (t & 0xff0f) <= 0xdd07) || (t & 0xfc3f) === 0xd012;
const REG: Record<string, 'a' | 'x' | 'y'> = { STA: 'a', STX: 'x', STY: 'y' };
const LOAD: Record<string, 'a' | 'x' | 'y'> = { LDA: 'a', LDX: 'x', LDY: 'y' };
/** the register each instruction changes (A: also every other one that loads or computes into it) */
const CHANGES: Record<string, 'a' | 'x' | 'y'> = { LDX: 'x', LDY: 'y', TAX: 'x', TAY: 'y', INX: 'x', DEX: 'x', INY: 'y', DEY: 'y', TSX: 'x', LAX: 'x' };
const changesA = (mn: string, mode: string) => CLOBBER_A.has(mn) || mn === 'LDA' || mn === 'TXA' || mn === 'TYA' || (SHIFT_MN.has(mn) && mode === 'acc');

/**
 * The timer read the value stored at `w` comes from, in the straight run before it, and the most the value can be
 * (the AND, or else the EOR, between them); null when it does not come from a timer.
 */
function timerValue(ctx: Ctx, w: Addr): { read: Addr; timer: Addr; most: number } | null {
  const { mem, insLen } = ctx;
  let reg = REG[OPC[mem[w]].mn], and: number | null = null, eor: number | null = null, a = w;
  for (let n = 0; n < 8; n++) {
    let q = -1;
    for (let k = 1; k <= 3; k++) if (insLen[(a - k) & 0xffff] === k && OPC[mem[(a - k) & 0xffff]].flow === 'seq') q = (a - k) & 0xffff;
    if (q < 0) return null;
    a = q;
    const o = OPC[mem[a]], d = decode(mem, a);
    if (!(reg === 'a' ? changesA(o.mn, o.mode) : CHANGES[o.mn] === reg || (o.mn === 'LAX' && reg === 'x'))) continue;
    if (LOAD[o.mn] === reg) {
      if ((o.mode !== 'abs' && o.mode !== 'zp') || !counts(d.v!)) return null;
      const most = and ?? eor;
      return most == null ? null : { read: a, timer: d.v!, most };
    }
    // a transfer: the value was in the other register before it
    if (o.mn === 'TXA' || o.mn === 'TYA') { reg = o.mn === 'TXA' ? 'x' : 'y'; continue; }
    if (o.mn === 'TAX' || o.mn === 'TAY') { reg = 'a'; continue; }
    if (o.mode !== 'imm') return null;
    if (o.mn === 'AND') and = Math.min(and ?? 0xff, d.v!);
    else if (o.mn === 'EOR') eor = eor ?? d.v!;
    else if (o.mn !== 'ORA' && o.mn !== 'ADC' && o.mn !== 'SBC') return null;
  }
  return null;
}

/** The cycles from each way in to the end, when every one of the `n + 1` ways in ends exactly at `start + n`. */
function waysIn(mem: Uint8Array, start: Addr, n: number): number[] | null {
  const end = start + n, out: number[] = [];
  for (let o = 0; o <= n; o++) {
    let pc = start + o, c = 0;
    while (pc < end) {
      const op = OPC[mem[pc]];
      // only instructions that take time: no flow, nothing written
      if (op.flow !== 'seq' || op.jam || op.access === 'write' || op.access === 'rmw') return null;
      c += instructionCycles(mem, pc).base;
      pc += op.len;
    }
    if (pc !== end) return null;
    out.push(c);
  }
  return out;
}

/** 5.4b: finds the timing code the trace reached (after an evidence pass), decodes its delays from their start. */
export function findDelays(ctx: Ctx): void {
  const { mem, insLen, codeOwner, xrefs, entryKind, skip, loaded, L } = ctx;
  for (const [s, w] of ctx.ev.smc) {
    if (ctx.delays.has(s) || OPC[mem[s]].flow !== 'br' || !insLen[s] || !REG[OPC[mem[w]].mn]) continue;
    const wo = OPC[mem[w]];
    if ((wo.mode !== 'abs' && wo.mode !== 'zp') || decode(mem, w).v !== ((s + 1) & 0xffff)) continue;
    const t = timerValue(ctx, w);
    if (!t || t.most < 1 || t.most > 63) continue;
    const start = (s + 2) & 0xffff, end = start + t.most;
    if (!loaded(end - 1)) continue;
    const ways = waysIn(mem, start, t.most);
    if (!ways) continue;
    // decoded from its start: a snapshot may have been taken with the branch going in further
    const at = decode(mem, s).target!;
    if (!insLen[start]) {
      for (let a = start; a < end; a++) { insLen[a] = 0; codeOwner[a] = -1; skip.delete(a); if (a !== start && entryKind.get(a) === 'branch') entryKind.delete(a); }
      for (let a = start; a < end; a += OPC[mem[a]].len) { insLen[a] = OPC[mem[a]].len; for (let k = 1; k < insLen[a]; k++) codeOwner[a + k] = a; }
      const l = xrefs.get(at); if (l) { const r = l.filter(x => !(x.from === s && x.kind === 'branch')); if (r.length) xrefs.set(at, r); else xrefs.delete(at); }
      ctx.addX(start, s, 'branch');
      if (!entryKind.has(start)) entryKind.set(start, 'branch');
    }
    const ins: Addr[] = [];
    for (let a = start; a < end; a += insLen[a] || 1) if (insLen[a]) ins.push(a);
    // the operands only take time: what they read is no data of the program
    for (const [to, l] of xrefs) {
      const r = l.filter(x => !ins.includes(x.from));
      if (r.length !== l.length) { if (r.length) xrefs.set(to, r); else xrefs.delete(to); }
    }
    const sled: DelaySled = { branch: s, by: w, read: t.read, timer: t.timer, start, end, enter: (at - start) & 0xffff, most: t.most, cycles: [Math.min(...ways), Math.max(...ways)], ins };
    ctx.delays.set(s, sled);
    for (const a of ins) ctx.delayIns.add(a);
    const sym = hwSymbol(t.timer);
    L('info', `Timing code at ${$4(s)}: the ${OPC[mem[s]].mn} is set from ${sym ? `${sym.text} (${$4(t.timer)})` : $4(t.timer)} at ${$4(t.read)}, and enters the delay at ${$4(start)}-${$4(end - 1)} 0-${t.most} bytes in: ${sled.cycles[1]} down to ${sled.cycles[0]} cycles, to make the timing stable`, s, 'code');
  }
}
