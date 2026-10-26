/* 5.1 memory image, 5.2 user overrides, 5.3 BASIC stubs */
import type { Ctx } from './context';
import { T, TYPE_BY_KEY } from '../model';
import type { BlockKind } from '../types';
import { $4 } from '../util/hex';
import { parseBasic } from '../c64/basic';

export function loadMemory(ctx: Ctx): void {
  const { files, mem, owner, L } = ctx;
  files.forEach((f, i) => {
    const end = Math.min(0x10000, f.load + f.bytes.length);
    let overlap = 0;
    for (let a = f.load; a < end; a++) { if (owner[a] >= 0) overlap++; mem[a] = f.bytes[a - f.load]; owner[a] = i; }
    L('info', `Loaded ${f.name}: ${$4(f.load)}-${$4(end - 1)}, ${end - f.load} bytes`, f.load, 'load');
    if (f.load + f.bytes.length > 0x10000) L('warn', `${f.name} runs past $ffff and was truncated`, f.load, 'load');
    if (overlap) L('warn', `${f.name} overlaps ${overlap} bytes of an earlier file; the later file wins`, f.load, 'load');
  });
}

/** Later overrides win; 'auto' clears. Unknown type names (old project files) count as data.
 * Only what still wins counts: an override that later ones cover completely leaves no block boundary, props,
 * entry point or code sweep behind, so marking a range merges the overrides inside it into the new block. */
export function applyOverrides(ctx: Ctx): void {
  const { project, ov, ovProps } = ctx;
  const list = project.overrides || [];
  const win = new Int32Array(0x10000).fill(-1);
  list.forEach((o, i) => {
    for (let a = o.start; a < o.end && a < 0x10000; a++) { ov[a] = o.type === 'auto' ? 0 : (TYPE_BY_KEY[o.type as BlockKind] || T.DATA); win[a] = o.type === 'auto' ? -1 : i; }
  });
  // a block boundary (with that override's props) wherever the winning override changes
  const live = new Set<number>();
  for (let a = 0; a < 0x10000; a++) { const i = win[a]; if (i >= 0) { live.add(i); if (a === 0 || win[a - 1] !== i) ovProps.set(a, list[i]); } }
  ctx.ovList = list.filter((_o, i) => live.has(i));
}

export function findBasicStubs(ctx: Ctx): void {
  const { files, ov, mem, owner, basics, L } = ctx;
  files.forEach((f, i) => {
    // a file that starts before $0801 and covers it (a memory dump, a VICE snapshot from $0200) counts only a stub
    // that SYSes into the same file, so dump bytes that happen to look like a BASIC line are not taken for one
    const covers = f.load < 0x0801 && f.load + f.bytes.length > 0x0801;
    if ((f.load !== 0x0801 && !covers) || ov[0x0801]) return;
    const b = parseBasic(mem, owner, 0x0801);
    if (b && covers && (b.sys == null || owner[b.sys] !== i)) return;
    if (b) {
      b.file = i; basics.push(b);
      L('ok', `BASIC stub: ${b.lines.map(l => l.text).join(' : ')}` + (b.sys != null ? ` → entry ${$4(b.sys)}` : ''), 0x0801, 'entry');
    }
  });
}
