/* 5.13 heuristics (unreached code islands, compression) and 5.14 statistics */
import type { Ctx } from './context';
import type { Addr, Block, LabelInfo, MusicInfo, Stats } from '../types';
import { T } from '../model';
import { OPC, type OpcodeInfo } from '../cpu/opcodes';
import { decode } from '../cpu/decode';
import { hwSymbol, isIO } from '../c64/symbols';
import { $4, now } from '../util/hex';
import { trial } from './trace';

/**
 * Without bank tracking an access to I/O inside the loaded bytes (a memory dump over $d000-$dfff) names the RAM byte
 * below it, as `charset_d020`. Report that once, with the setting that writes them as registers again.
 */
export function ioLabelNotice(ctx: Ctx, labels: Map<Addr, LabelInfo>): void {
  if (ctx.S.bankTracking) return;
  const { xrefs, insLen, loaded, L } = ctx;
  const io = [...labels.keys()].filter(a => isIO(a) && loaded(a) && hwSymbol(a)
    && (xrefs.get(a) || []).some(x => insLen[x.from] && x.kind !== 'call' && x.kind !== 'jump' && x.kind !== 'branch')).sort((x, y) => x - y);
  if (!io.length) return;
  const shown = io.slice(0, 4).map(a => `${$4(a)} ${labels.get(a)!.name}`).join(', ') + (io.length > 4 ? ', …' : '');
  L('warn', `Bank tracking is off, so the code's accesses to ${io.length} I/O address${io.length === 1 ? '' : 'es'} inside the loaded bytes are written as labels (${shown}). Turn on Settings → Analysis → Follow the memory configuration ($01) and VIC bank to write them as registers.`, io[0], 'banks');
}

/** A routine in a data block that nothing traced reaches: where it starts and ends, its instructions and the last one. */
export interface CodeIsland { at: Addr; end: Addr; n: number; last: string }

/**
 * 5.13 code islands: the data blocks that start with a routine. After fill (3+ equal bytes) and bytes the code uses as
 * data, at one of the next 8 addresses: at least 6 documented instructions ending in RTS, JMP or (in a handler that
 * acknowledges its interrupt) RTI, with no BRK, all inside the block, every branch landing in it (after the start) or
 * on traced code, no JSR/JMP into the middle of a traced instruction or into a player (but for its init and play),
 * and not 1541 drive code. User blocks are the user's word and stay as they are. A deep analysis (`left`: the starts
 * it left out) looks for routines all through the block and lets their branches leave it, as each one is traced on
 * trial (5.17).
 */
export function codeIslands(ctx: Ctx, blocks: Block[], music: MusicInfo[] = [], left?: (a: Addr) => boolean): CodeIsland[] {
  const { mem, insLen, codeOwner, xrefs } = ctx;
  const out: CodeIsland[] = [];
  const asData = (a: Addr) => (xrefs.get(a) || []).some(x => x.kind === 'read' || x.kind === 'write' || x.kind === 'rmw');
  // 1541 code in the C64's memory (a fast loader's drive code) is data here: it reads the drive's VIA registers
  // ($1800-$180f, $1c00-$1c0f) or waits for a GCR byte with `bvc *`
  const via = (t: Addr | null) => t != null && ((t >= 0x1800 && t < 0x1810) || (t >= 0x1c00 && t < 0x1c10));
  const routine = (s: Addr, e: Addr): CodeIsland | null => {
    let p = s, n = 0, drive = 0, ack = false, last: OpcodeInfo | null = null;
    while (p < e && n < 64) {
      const o = OPC[mem[p]];
      if (o.ill || o.jam || o.flow === 'brk' || p + o.len > e) return null;
      const t = decode(mem, p).target;
      // a deep analysis traces the routine on trial, branches out of the block too
      if (o.flow === 'br' && !(t! >= s && t! < e) && !insLen[t!] && !left) return null;
      if ((o.flow === 'jsr' || o.flow === 'jmp') && codeOwner[t!] >= 0 && !insLen[t!]) return null;
      // into a player other than by its init and play (a copy of the player's code, say)
      if ((o.flow === 'jsr' || o.flow === 'jmp') && music.some(m => t! >= m.start && t! < m.end && t !== m.init && t !== m.play)) return null;
      if ((o.mode === 'abs' && via(t)) || (mem[p] === 0x50 && mem[p + 1] === 0xfe)) drive++;
      if (o.mode === 'abs' && ((t === 0xd019 && o.access !== 'read') || ((t === 0xdc0d || t === 0xdd0d) && o.access !== 'write'))) ack = true;
      n++; p += o.len;
      if (o.flow === 'ret' || o.flow === 'jmp' || o.flow === 'jmpi') { last = o; break; }
    }
    // an interrupt handler acknowledges its interrupt; $40 (RTI) ends many a table
    return last && n >= 6 && drive < 2 && (last.mn !== 'RTI' || ack) ? { at: s, end: p, n, last: last.mn } : null;
  };
  for (const b of blocks) {
    if (b.type !== 'data' || b.user || b.end - b.start < 12) continue;
    let s = b.start;
    let z = 0; while (s + z < b.end && mem[s + z] === mem[s]) z++;
    if (z >= 3) s += z;
    while (s < b.end && asData(s)) s++;
    if (left) {
      for (let a = s; a + 6 <= b.end;) {
        let f = 0; while (a + f < b.end && mem[a + f] === mem[a]) f++;
        if (f >= 3) { a += f; continue; }
        const r = left(a) || asData(a) ? null : routine(a, b.end);
        if (r) { out.push(r); a = r.end; } else a++;
      }
      continue;
    }
    for (let k = 0; k < 8 && s + k < b.end; k++) {
      const r = routine(s + k, b.end);
      if (r) { out.push(r); break; }
    }
  }
  return out;
}

export function diagnostics(ctx: Ctx, blocks: Block[]): void {
  const { mem, L, deep, rejected } = ctx;
  // a deep analysis traces the bytes on trial: what runs into a problem is data, and needs no hint (5.17)
  const data = (b: Block) => {
    if (!deep) return false;
    for (const a of rejected.keys()) if (a >= b.start && a < b.end && a < b.start + 16) return true;
    const why = trial(ctx, b.start, 'guess');
    if (why) rejected.set(b.start, { kind: 'guess', why });
    return !!why;
  };
  for (const b of blocks) {
    if (b.type !== 'data' || b.end - b.start < 12) continue;
    let p = b.start, n = 0, end = false;
    while (p < b.end && n < 64) {
      const o = OPC[mem[p]];
      if (o.ill || p + o.len > b.end) break;
      n++; p += o.len;
      if (o.flow === 'ret' || o.flow === 'jmp') { end = true; break; }
    }
    if (end && n >= 6 && !data(b)) { b.hint = 'code'; L('hint', `Possible unreached code at ${$4(b.start)} (${n} valid instructions ending in ${OPC[mem[p - OPC[mem[p - 1]].len]]?.mn || 'RTS'}). Select it and press C to disassemble.`, b.start, 'data'); }
  }
  const entropy = (s: Addr, e: Addr) => { const c = new Uint32Array(256); for (let i = s; i < e; i++) c[mem[i]]++; let H = 0; const n = e - s; for (const k of c) if (k) { const p = k / n; H -= p * Math.log2(p); } return H; };
  for (const b of blocks) b.entropy = entropy(b.start, b.end);
  let dataBytes = 0, dataH = 0;
  for (const b of blocks) if (b.type === 'data' && b.end - b.start >= 256) { dataBytes += b.end - b.start; dataH += b.entropy * (b.end - b.start); }
  if (dataBytes >= 2048 && dataH / dataBytes > 7.2) L('warn', `Unclassified data has very high entropy (${(dataH / dataBytes).toFixed(2)} bits/byte). The program is probably crunched; unpack it (Unpack in the app, or mimir unpack) and load the result.`, null, 'data');
}

export function statistics(ctx: Ctx, tm: Uint8Array, blocks: Block[], labels: Map<Addr, LabelInfo>, t0: number): Stats {
  const { owner, insLen, skip, mem, xrefs, entryKind, L } = ctx;
  const stats: Stats = { mn: {}, modes: {}, illegal: 0, illegalList: [], ins: 0, bytesByType: {}, codeBytes: 0, total: 0, xrefs: 0, entries: entryKind.size, labels: labels.size, ms: 0 };
  for (let p = 0; p < 0x10000; p++) {
    if (owner[p] >= 0) { stats.total++; stats.bytesByType[tm[p]] = (stats.bytesByType[tm[p]] || 0) + 1; }
    if (!insLen[p] || skip.has(p)) continue;
    const o = OPC[mem[p]];
    stats.ins++; stats.mn[o.mn] = (stats.mn[o.mn] || 0) + 1; stats.modes[o.mode] = (stats.modes[o.mode] || 0) + 1;
    if (o.ill) { stats.illegal++; if (stats.illegalList.length < 100) stats.illegalList.push(p); }
  }
  for (const l of xrefs.values()) stats.xrefs += l.length;
  stats.ms = now() - t0;
  const codeCount = stats.bytesByType[T.CODE] || 0;
  L('ok', `Analysis finished in ${stats.ms.toFixed(1)} ms: ${stats.ins} instructions, ${blocks.length} blocks, ${labels.size} labels, ${stats.xrefs} cross-references, ${Math.round(100 * codeCount / Math.max(1, stats.total))}% code`, null, 'analysis');
  return stats;
}
