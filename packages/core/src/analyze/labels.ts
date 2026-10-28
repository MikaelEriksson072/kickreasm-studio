/* 5.12 automatic labels and zero-page variables */
import { PRI, type Ctx } from './context';
import { findBlock, type Classification } from './classify';
import type { Addr, EntryKind, LabelInfo, ZpVar } from '../types';
import { T } from '../model';
import { hwSymbol } from '../c64/symbols';
import { h2, h4 } from '../util/hex';
import type { VicEvidence } from '../types';

export function makeLabels(ctx: Ctx, cls: Classification, vic: VicEvidence): { labels: Map<Addr, LabelInfo>; zp: Map<Addr, ZpVar> } {
  const { basics, entryKind, insLen, codeOwner, xrefs, ijumps, entry, loaded } = ctx;
  const { smc, wordPtrs } = ctx.ev;
  const { tm, blocks, objStarts, written, indexedRef } = cls;
  const labels = new Map<Addr, LabelInfo>();
  const setLabel = (addr: Addr, name: string, kind: string) => { if (!labels.has(addr)) labels.set(addr, { name, kind }); };
  // `start` is the program start: the BASIC SYS target, unless the user set another one
  const userStart = ctx.project.entryPoint != null && loaded(ctx.project.entryPoint);
  for (const b of basics) if (b.sys != null && (!userStart || b.sys === entry)) setLabel(b.sys, 'start', 'entry');
  // Spindle's drivers and the routines they call (5.4c), named after their part
  const code = (a: Addr | null): a is Addr => a != null && loaded(a) && insLen[a] > 0;
  // a name once: a routine read wrongly must not name a second address the same
  const named = new Set<string>();
  const name = (a: Addr, n: string) => { if (!named.has(n) && !labels.has(a)) { named.add(n); setLabel(a, n, 'spindle'); } };
  for (const [i, d] of ctx.spindle.entries()) {
    // `|` goes on with its part: a second driver of it
    const n = `part${d.part}`, more = ctx.spindle.slice(0, i).filter(x => x.part === d.part).length;
    if (d.first && d.start !== d.front) name(d.start, 'spindle_start');
    name(d.front, more ? `${n}_driver${more + 1}` : `${n}_driver`);
    if (d.side != null) name(d.side, `${n}_seek`);
    for (const [k, a] of [['prepare', d.prepare], ['setup', d.setup], ['irq', d.irq], ['main', d.main], ['fadeout', d.fadeout], ['cleanup', d.cleanup]] as const) if (code(a)) name(a, `${n}_${k}`);
    const next = ctx.spindle.find(x => x.front === d.next);
    if (next && code(d.prepareNext)) name(d.prepareNext, `part${next.part}_prepare`);
  }
  const kindPrefix: Partial<Record<EntryKind, string>> = { entry: 'entry', irq: 'irq', nmi: 'nmi', brk: 'brk', user: 'code', sub: 'sub', ptr: 'fx', guess: 'code' };
  for (const [addr, kind] of [...entryKind].sort((x, y) => PRI[y[1]] - PRI[x[1]])) {
    if (!insLen[addr] || tm[addr] === T.MUSIC) continue;
    if (kind === 'branch' || kind === 'jmp') continue;
    setLabel(addr, kind === 'entry' && addr === entry ? 'start' : `${kindPrefix[kind]}_${h4(addr)}`, kind);
  }
  // the start of a delay that timing code enters (5.4b)
  for (const s of ctx.delays.values()) setLabel(s.start, `delay_${h4(s.start)}`, 'delay');
  for (const [to, l] of xrefs) {
    if (!insLen[to] || labels.has(to) || tm[to] === T.MUSIC) continue;
    const fl = l.filter(x => (x.kind === 'branch' || x.kind === 'jump') && x.from !== to);
    if (!fl.length) continue;
    const back = fl.some(x => x.kind === 'branch' && x.from >= to), fwd = fl.some(x => x.kind === 'branch' && x.from < to);
    const jmp = fl.some(x => x.kind === 'jump');
    setLabel(to, `${jmp || (back && fwd) ? 'l' : back ? 'loop' : 'skip'}_${h4(to)}`, 'branch');
  }
  for (const s of smc.keys()) if (tm[s] !== T.MUSIC) setLabel(s, `smc_${h4(s)}`, 'smc');
  const dataName = (addr: Addr) => {
    const b = findBlock(blocks, addr);
    if (!b) return `data_${h4(addr)}`;
    const p = b.props;
    switch (b.type) {
      case 'text': return `txt_${h4(addr)}`;
      case 'table': return `${p.sub === 'sine' ? 'sine' : p.sub === 'colors' ? 'colors' : 'tbl'}_${h4(addr)}`;
      case 'lohi': return `${p.ptr ? 'ptr' : 'tbl'}${p.part}_${h4(addr)}`;
      case 'words': return `ptrs_${h4(addr)}`;
      case 'sprite': return `spr_${h4(addr)}`;
      case 'charset': return `charset_${h4(addr)}`;
      case 'bitmap': return `bitmap_${h4(addr)}`;
      case 'screen': return `screen_${h4(addr)}`;
      case 'fill': return `buf_${h4(addr)}`;
      case 'code': return `l_${h4(addr)}`;
      default: return `${written(addr) ? 'var' : indexedRef(addr) ? 'tbl' : 'data'}_${h4(addr)}`;
    }
  };
  for (const addr of [...objStarts].sort((x, y) => x - y)) {
    if (!loaded(addr) || tm[addr] === T.MUSIC || codeOwner[addr] >= 0) continue;
    setLabel(addr, dataName(addr), 'data');
  }
  for (const b of blocks) {
    if (b.type === 'lohi' || b.type === 'text' || b.type === 'sprite' || b.type === 'charset' || b.type === 'bitmap' || b.type === 'screen' || b.type === 'table' || b.type === 'words' || (b.type === 'code' && b.user)) setLabel(b.start, dataName(b.start), 'data');
  }
  for (const b of blocks) if (b.type === 'sprite') for (let s = b.start + 64; s < b.end; s += 64) if (vic.sprites.some(x => x.addr === s)) setLabel(s, `spr_${h4(s)}`, 'data');

  // zero-page variables
  const zp = new Map<Addr, ZpVar>();
  for (const [to, l] of xrefs) {
    if (to >= 0x100 || loaded(to)) continue;
    if (!l.some(x => x.kind !== 'branch' && x.kind !== 'jump' && x.kind !== 'call')) continue;
    if (hwSymbol(to)) continue;
    const isPtr = l.some(x => x.kind === 'ptr') || wordPtrs.has(to);
    zp.set(to, { name: `${isPtr ? 'ptr' : 'zp'}_${h2(to)}`, ptr: isPtr });
  }
  for (const p of wordPtrs) if (p < 0x100 && !loaded(p) && !hwSymbol(p)) { zp.set(p, { name: `ptr_${h2(p)}`, ptr: true }); if (zp.get(p + 1) && !zp.get(p + 1)!.user) zp.set(p + 1, { name: `ptr_${h2(p)}`, ptr: true, off: 1 }); }
  for (const j of ijumps) if (j.ptr < 0x100 && !hwSymbol(j.ptr)) { zp.set(j.ptr, { name: `ptr_${h2(j.ptr)}`, ptr: true }); zp.set(j.ptr + 1, { name: `ptr_${h2(j.ptr)}`, ptr: true, off: 1 }); }
  return { labels, zp };
}
