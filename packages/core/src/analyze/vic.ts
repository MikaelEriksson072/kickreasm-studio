/* 5.9 VIC-II evidence: banks, $d018, bitmap/multicolor bits and sprite pointers.
 * With bank tracking (5.8b) a store where I/O is banked out goes to RAM and is no VIC evidence, the bank
 * comes from $dd00 and the $dd02 trick, and $d018 and sprite pointers count in the bank selected where
 * they are written. Without it every $d018 value is tried in every bank written to $dd00. */
import type { Ctx } from './context';
import type { Addr, GfxCandidate, MemConfigInfo, VicEvidence } from '../types';
import { T } from '../model';
import { $2, $4 } from '../util/hex';
import { isIO } from '../c64/symbols';
import { banksOf, ioVisible } from '../c64/memconfig';

export function vicEvidence(ctx: Ctx, mcfg: MemConfigInfo | null = null): { vic: VicEvidence; gfx: GfxCandidate[] } {
  const { loaded } = ctx;
  const writes = mcfg ? ctx.ev.writes.filter(w => !isIO(w.dest) || ioVisible(mcfg.port[w.pc]) !== 'none') : ctx.ev.writes;
  const vic: VicEvidence = { banks: new Set(), d018: new Set(), bitmap: false, multicolor: false, sprites: [] };
  /** with tracking: the banks an instruction can run with */
  const banksAt = (pc: Addr) => banksOf(mcfg!.vic[pc] || 1);
  for (const w of writes) {
    if (w.v == null) continue;
    if (w.dest === 0xdd00 && !mcfg) vic.banks.add(3 - (w.v & 3));
    if (w.dest === 0xd018) {
      vic.d018.add(w.v);
      if (mcfg) for (const b of banksAt(w.pc)) vic.banks.add(b);
    }
    if (w.dest === 0xd011 && (w.v & 0x20)) vic.bitmap = true;
    if (w.dest === 0xd016 && (w.v & 0x10)) vic.multicolor = true;
  }
  if (mcfg) for (const c of mcfg.changes.values()) if (c.vic != null) for (const b of banksOf(c.vic)) vic.banks.add(b);
  if (!vic.banks.size) vic.banks.add(0);
  // A split screen (a bitmap logo above text, say) writes $d018 for both modes. With bank tracking a $d018 write
  // selects a bitmap only when the $d011 write nearest to it in the code turns bitmap mode on; without it, any
  // bitmap mode makes every $d018 value a bitmap.
  const d011 = writes.filter(w => w.dest === 0xd011 && w.v != null);
  const bitmapFor = (pc: Addr) => {
    let near: (typeof d011)[number] | null = null;
    for (const d of d011) if (!near || Math.abs(d.pc - pc) < Math.abs(near.pc - pc)) near = d;
    return !!near && !!(near.v! & 0x20);
  };
  const d018Modes = new Map<number, { v: number; bitmap: boolean }[]>();
  if (mcfg) for (const w of writes) {
    if (w.dest !== 0xd018 || w.v == null) continue;
    const bitmap = bitmapFor(w.pc);
    for (const b of banksAt(w.pc)) {
      let l = d018Modes.get(b); if (!l) d018Modes.set(b, l = []);
      if (!l.some(x => x.v === w.v && x.bitmap === bitmap)) l.push({ v: w.v, bitmap });
    }
  }
  const gfx: GfxCandidate[] = [];
  // character ROM is visible to the VIC at $1000-$1fff in banks 0 and 2
  const romChars = (bank: number, a: Addr) => (bank === 0 || bank === 2) && (a & 0x3fff) >= 0x1000 && (a & 0x3fff) < 0x2000;
  const screens = new Set<Addr>([0x0400]);
  for (const bank of vic.banks) {
    const bb = bank * 0x4000;
    for (const { v, bitmap } of mcfg ? d018Modes.get(bank) || [] : [...vic.d018].map(v => ({ v, bitmap: vic.bitmap }))) {
      const scr = bb + ((v >> 4) & 15) * 0x400;
      screens.add(scr);
      if (bitmap) gfx.push({ type: T.BITMAP, start: bb + ((v >> 3) & 1) * 0x2000, size: 8000, why: `$d011 bitmap mode + $d018=${$2(v)}` });
      else {
        const cs = bb + ((v >> 1) & 7) * 0x800;
        if (!romChars(bank, cs)) gfx.push({ type: T.CHARSET, start: cs, size: 2048, why: `$d018=${$2(v)} selects charset at ${$4(cs)}` });
      }
      if (scr !== 0x0400 && loaded(scr)) gfx.push({ type: T.SCREEN, start: scr, size: 1000, why: `$d018=${$2(v)} selects screen at ${$4(scr)}` });
    }
    for (const w of writes) {
      if (w.v == null || (mcfg && !banksAt(w.pc).includes(bank))) continue;
      for (const scr of screens) {
        if ((scr & 0xc000) !== bb) continue;
        if (w.dest >= scr + 0x3f8 && w.dest <= scr + 0x3ff) {
          const sa = bb + w.v * 64;
          vic.sprites.push({ n: w.dest - scr - 0x3f8, ptr: w.v, addr: sa });
          gfx.push({ type: T.SPRITE, start: sa, size: 64, why: `sprite pointer ${$4(w.dest)} = ${$2(w.v)}` });
        }
      }
    }
  }
  return { vic, gfx };
}
