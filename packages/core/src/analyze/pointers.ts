/* 5.6 lo/hi pointer tables, jump tables and unresolved indirect jumps */
import { VECTORS, type Ctx } from './context';
import type { Addr, LohiTable } from '../types';
import { $2, $4 } from '../util/hex';

/** Turns lo/hi pair candidates into tables; returns the number of new code entry points. */
export function resolveTables(ctx: Ctx): number {
  const { lohiTabs, wordTables, mem, insLen, codeOwner, ijumps, xrefs, loaded, enqueue, L } = ctx;
  const { lohi, ptrTargets } = ctx.ev;
  let added = 0;
  for (const p of lohi) {
    if (lohiTabs.has(p.lo) || wordTables.has(p.lo)) continue;
    // `lda tab,x / sta vec / lda tab+1,x / sta vec+1 / jmp (vec)` (the index doubled): a .word table of code addresses.
    // It ends at the next byte the code refers to, or at a word that is not a loaded address.
    if (p.hi === p.lo + 1 && (ijumps.some(j => j.ptr === p.dest) || VECTORS[p.dest])) {
      const vk = VECTORS[p.dest];
      const targets: Addr[] = [];
      for (let t = p.lo; targets.length < 64 && loaded(t) && loaded(t + 1) && !insLen[t] && codeOwner[t] < 0 && !insLen[t + 1] && codeOwner[t + 1] < 0; t += 2) {
        if (t > p.lo && xrefs.has(t)) break;
        const v = mem[t] | (mem[t + 1] << 8);
        if (!loaded(v) || (v >= p.lo && v < t + 2)) break;
        targets.push(v);
      }
      if (targets.length) {
        wordTables.set(p.lo, { len: targets.length * 2, dest: p.dest, targets });
        L('ok', `Word table at ${$4(p.lo)}: ${targets.length} code addresses (jump table via (${$4(p.dest)}))`, p.lo, 'data');
        for (const v of targets) { enqueue(v, vk || 'ptr'); added++; }
        continue;
      }
    }
    const runLen = (t: Addr) => { let n = 0; while (n < 256 && loaded(t + n) && !insLen[t + n] && codeOwner[t + n] < 0 && !(n > 0 && (t + n === p.lo || t + n === p.hi))) n++; return n; };
    const len = Math.min(runLen(p.lo), runLen(p.hi));
    if (!len) continue;
    let hits = 0;
    const targets: Addr[] = [];
    for (let i = 0; i < len; i++) { const v = mem[p.lo + i] | (mem[p.hi + i] << 8); targets.push(v); if (loaded(v)) hits++; }
    const isPtr = hits >= Math.max(1, Math.ceil(len * 0.75));
    let useLen = len;
    if (isPtr) { useLen = 0; while (useLen < len && loaded(targets[useLen])) useLen++; }
    const viaJmp = ijumps.some(j => j.ptr === p.dest);
    const vk = VECTORS[p.dest];
    const t = { lo: p.lo, hi: p.hi, len: useLen, ptr: isPtr, dest: p.dest, code: isPtr && (viaJmp || !!vk), targets: targets.slice(0, useLen) };
    lohiTabs.set(p.lo, Object.assign({ part: 'lo', partner: p.hi }, t) as LohiTable);
    lohiTabs.set(p.hi, Object.assign({ part: 'hi', partner: p.lo }, t) as LohiTable);
    L(isPtr ? 'ok' : 'info', `${isPtr ? 'Pointer' : 'Lo/hi value'} table pair: lo ${$4(p.lo)} / hi ${$4(p.hi)}, ${useLen} entries` + (t.code ? (vk ? ` (${vk.toUpperCase()} handlers)` : ` (jump table via (${$2(p.dest)}))`) : ''), p.lo, 'data');
    if (isPtr) for (const v of t.targets) {
      if (t.code) { enqueue(v, vk || 'ptr'); added++; } else ptrTargets.set(v, p.dest);
    }
  }
  return added;
}

export function warnUnresolvedJumps(ctx: Ctx): void {
  const { ijumps, lohiTabs, L } = ctx;
  for (const j of ijumps) {
    if (![...lohiTabs.values()].some(t => t.dest === j.ptr && t.code) && ![...ctx.wordTables.values()].some(t => t.dest === j.ptr) && !VECTORS[j.ptr])
      L('warn', `Indirect JMP (${$4(j.ptr)}) at ${$4(j.pc)}: target unknown at analysis time`, j.pc, 'code');
  }
}
