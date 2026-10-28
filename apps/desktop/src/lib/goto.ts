/* What the "Go to" dialog accepts: a hex address, a label, or a range of either ("$2000-$27ff",
 * "sine_09b5..$0ab4"). The end of a range is included, as in the status bar's "sel" item. */
import type { Addr } from '@mimir/core';

export type GotoTarget = { addr: Addr } | { start: Addr; end: Addr } | { error: string };

export const GOTO_HELP = 'Enter a hex address like $0810, a range like $2000-$27ff, or an existing label name.';

export function parseGoto(text: string, labelAddr: (name: string) => Addr | undefined): GotoTarget {
  const one = (s: string): Addr | undefined => {
    const t = s.trim();
    const l = labelAddr(t);
    if (l != null) return l;
    const m = t.match(/^(?:\$|0x)?([0-9a-fA-F]{1,4})$/);
    return m ? parseInt(m[1], 16) : undefined;
  };
  const s = text.trim();
  const a = one(s);
  if (a != null) return { addr: a };
  // labels never contain '-' or '.', so the first separator splits the range
  const r = s.match(/^(.+?)\s*(?:\.\.|-|–|—)\s*(.+)$/);
  if (r) {
    const x = one(r[1]), y = one(r[2]);
    if (x != null && y != null) return { start: Math.min(x, y), end: Math.max(x, y) + 1 };
  }
  return { error: GOTO_HELP };
}
