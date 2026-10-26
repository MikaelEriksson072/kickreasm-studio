/* 5.5 evidence pass: constant propagation over linear runs of instructions */
import { emptyEvidence, VECTORS, type Ctx } from './context';
import { CLOBBER_A, OPC, SHIFT_MN } from '../cpu/opcodes';
import { decode } from '../cpu/decode';
import { SYM, isIO } from '../c64/symbols';
import type { Addr } from '../types';
import { $4 } from '../util/hex';

interface IndexedLoad { t: Addr; r: 'x' | 'y'; pc: Addr }
/** Known register content: an immediate value and where it was loaded, or an indexed table read. */
interface Reg { v: number | null; src?: Addr | null; idx?: IndexedLoad | null }
interface IdxStore { dest: Addr; t: Addr; r: 'x' | 'y' }

const evTag = (ctx: Ctx, a: Addr, tag: string) => {
  const dataEv = ctx.ev.dataEv;
  let s = dataEv.get(a); if (!s) dataEv.set(a, s = new Set()); s.add(tag);
};

export function evidence(ctx: Ctx): void {
  ctx.ev = emptyEvidence();
  const { writes, hints, ptrTargets, lohi, wordPtrs, textPtrs, smc } = ctx.ev;
  const { mem, insLen, codeOwner, xrefs, entryKind, inlineCalls, skip, loaded, addX, enqueue, L } = ctx;
  const starts: Addr[] = [];
  for (let a = 0; a < 0x10000; a++) if (insLen[a]) starts.push(a);
  let A: Reg | null = null, X: Reg | null = null, Y: Reg | null = null, recent = new Map<Addr, Reg>(), idxStores: IdxStore[] = [];
  const reset = () => { A = X = Y = null; recent = new Map(); idxStores = []; };
  const clearWritten = (from: Addr, to: Addr) => {
    for (let a = from; a <= to; a++) {
      if (!insLen[a]) continue;
      const o = OPC[mem[a]];
      if (o.mn === 'LDA' || o.mn === 'TXA' || o.mn === 'TYA' || CLOBBER_A.has(o.mn) || (SHIFT_MN.has(o.mn) && o.mode === 'acc')) A = null;
      if (['LDX', 'TAX', 'TSX', 'INX', 'DEX', 'LAX', 'AXS', 'LAS'].includes(o.mn)) X = null;
      if (['LDY', 'TAY', 'INY', 'DEY'].includes(o.mn)) Y = null;
      if (o.flow === 'jsr') A = X = Y = null;
    }
  };
  let prevEnd = -1, prevBreak = true;
  const pair = (dest: number, lo: Reg, hi: Reg) => {
    const value = lo.v! | (hi.v! << 8);
    if (dest >= 0 && !VECTORS[dest] && (isIO(dest) || dest >= 0xff00 || dest < 2)) return;
    const sym = SYM.exact.get(value);
    if (loaded(value) || (sym && sym.call)) {
      hints.set(lo.src!, { kind: 'lo', target: value });
      hints.set(hi.src!, { kind: 'hi', target: value });
    }
    if (loaded(dest)) wordPtrs.add(dest);
    const vk = VECTORS[dest];
    if (vk && loaded(value)) { let vs = ctx.ev.vectors.get(value); if (!vs) ctx.ev.vectors.set(value, vs = new Set()); vs.add(dest); enqueue(value, vk); L('ok', `${vk.toUpperCase()} vector ${$4(dest)} set to ${$4(value)} at ${$4(lo.src!)}`, lo.src!, 'entry'); }
    else if (loaded(value)) ptrTargets.set(value, dest);
  };
  for (const pc of starts) {
    const xs = xrefs.get(pc);
    const isTarget = entryKind.has(pc) || (xs && xs.some(x => x.kind === 'branch' || x.kind === 'jump' || x.kind === 'call'));
    if (pc !== prevEnd || prevBreak) reset();
    else if (isTarget) {
      const flowIn = xs ? xs.filter(x => x.kind === 'branch' || x.kind === 'jump' || x.kind === 'call') : [];
      const tight = !entryKind.has(pc) || entryKind.get(pc) === 'branch';
      if (tight && flowIn.length && flowIn.every(x => x.kind === 'branch' && x.from > pc && x.from - pc <= 24)) {
        clearWritten(pc, Math.max(...flowIn.map(x => x.from)));
      } else reset();
    }
    const info = OPC[mem[pc]], d = decode(mem, pc), mn = info.mn, mode = info.mode;
    prevEnd = (pc + insLen[pc]) & 0xffff;
    prevBreak = info.flow === 'jmp' || info.flow === 'jmpi' || info.flow === 'ret' || info.flow === 'brk' || inlineCalls.has(pc);
    if (skip.has(pc)) { reset(); continue; }
    // data references
    if (info.access && d.target != null) {
      const tgt = d.target;
      const kind = (mode === 'izx' || mode === 'izy') ? 'ptr' : info.access;
      addX(tgt, pc, kind);
      if (kind === 'ptr') addX(tgt + 1, pc, 'ptr');
      if ((info.access === 'write' || info.access === 'rmw') && loaded(tgt) && (insLen[tgt] || codeOwner[tgt] >= 0)) {
        const s = insLen[tgt] ? tgt : codeOwner[tgt];
        smc.set(s, pc);
        L('info', `Self-modifying code: ${$4(pc)} writes into the instruction at ${$4(s)}`, pc, 'code');
      }
    }
    const idxOf = (): IndexedLoad | null => (mode === 'abx' || mode === 'aby') && loaded(d.v!) && !insLen[d.v!] && codeOwner[d.v!] < 0 ? { t: d.v!, r: mode === 'abx' ? 'x' : 'y', pc } : null;
    // TypeScript narrows the `let` registers to null inside this loop body; read them through these accessors
    const a = (): Reg | null => A, x = (): Reg | null => X, y = (): Reg | null => Y;
    switch (mn) {
      case 'LDA': A = mode === 'imm' ? { v: d.v, src: pc } : (idxOf() ? { v: null, idx: idxOf() } : null); break;
      case 'LDX': X = mode === 'imm' ? { v: d.v, src: pc } : null; break;
      case 'LDY': Y = mode === 'imm' ? { v: d.v, src: pc } : null; break;
      case 'TAX': { const r = a(); X = r && r.v != null ? { v: r.v, src: null } : null; break; }
      case 'TAY': { const r = a(); Y = r && r.v != null ? { v: r.v, src: null } : null; break; }
      case 'TXA': { const r = x(); A = r && r.v != null ? { v: r.v, src: null } : null; break; }
      case 'TYA': { const r = y(); A = r && r.v != null ? { v: r.v, src: null } : null; break; }
      case 'INX': case 'DEX': { const r = x(); X = r && r.v != null ? { v: (r.v + (mn === 'INX' ? 1 : 255)) & 255, src: null } : null; break; }
      case 'INY': case 'DEY': { const r = y(); Y = r && r.v != null ? { v: (r.v + (mn === 'INY' ? 1 : 255)) & 255, src: null } : null; break; }
      case 'BEQ': case 'BNE': { const r = a(); if (r && r.idx) evTag(ctx, r.idx.t, 'zt'); break; }
      case 'STA': case 'STX': case 'STY': case 'SAX': {
        const R = mn === 'STA' ? a() : mn === 'STX' ? x() : mn === 'STY' ? y() : null;
        const dest = d.target!;
        if (mode === 'zp' || mode === 'abs') {
          writes.push({ pc, dest, v: R ? R.v : null });
          if (R && R.v != null && R.src != null) {
            recent.set(dest, R);
            const lo = recent.get((dest - 1) & 0xffff), hi = recent.get((dest + 1) & 0xffff);
            if (lo && lo.src !== R.src) pair((dest - 1) & 0xffff, lo, R);
            if (hi && hi.src !== R.src) pair(dest, R, hi);
          }
          if (R && R.idx) {
            for (const s of idxStores) {
              if (s.r !== R.idx.r || s.t === R.idx.t) continue;
              if (s.dest === dest - 1) lohi.push({ lo: s.t, hi: R.idx.t, dest: dest - 1, r: s.r, pc });
              else if (s.dest === dest + 1) lohi.push({ lo: R.idx.t, hi: s.t, dest, r: s.r, pc });
            }
            idxStores.push({ dest, t: R.idx.t, r: R.idx.r });
            const t = R.idx.t;
            if (dest >= 0xd020 && dest <= 0xd02e) evTag(ctx, t, 'color');
            else if (dest >= 0xd000 && dest <= 0xd00f) evTag(ctx, t, 'spritepos');
            else if (dest === 0xd012) evTag(ctx, t, 'raster');
            else if (dest >= 0xd400 && dest <= 0xd418) evTag(ctx, t, 'sid');
            else if (dest === 0xd016 || dest === 0xd011) evTag(ctx, t, 'scroll');
          }
        } else if (R && R.idx && (mode === 'abx' || mode === 'aby')) {
          if (dest >= 0x0400 && dest < 0x0800 && !loaded(dest)) evTag(ctx, R.idx.t, 'screen');
          else if (dest >= 0xd800 && dest < 0xdc00) evTag(ctx, R.idx.t, 'colorram');
        } else if (R && R.v != null && (mode === 'abx' || mode === 'aby')) {
          writes.push({ pc, dest, v: R.v, indexed: true });
        }
        break;
      }
      case 'JSR': {
        const t = d.target;
        const ra = a(), rx = x(), ry = y();
        if (t === 0xffd2 && ra && ra.idx) evTag(ctx, ra.idx.t, 'petscii');
        if (t === 0xab1e && ra && ra.v != null && ra.src != null && ry && ry.v != null && ry.src != null) {
          pair(-1, ra, ry); const v = ra.v | (ry.v << 8); if (loaded(v)) { textPtrs.set(v, 'petscii'); ptrTargets.delete(v); }
        }
        if (t === 0xffbd && rx && rx.v != null && rx.src != null && ry && ry.v != null && ry.src != null) {
          pair(-1, rx, ry); const v = rx.v | (ry.v << 8); if (loaded(v)) { textPtrs.set(v, 'petscii'); ptrTargets.delete(v); }
        }
        A = X = Y = null; break;
      }
      default:
        if (CLOBBER_A.has(mn) || (SHIFT_MN.has(mn) && mode === 'acc')) A = null;
        if (mn === 'TSX' || mn === 'AXS' || mn === 'LAS' || mn === 'LAX') X = null;
        if (mn === 'LAX') A = null;
    }
  }
}
