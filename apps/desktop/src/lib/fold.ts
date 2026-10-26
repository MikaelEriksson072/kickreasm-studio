/* Folding in the listing: a folded block shows only its header line. The view keeps each line's number in its
 * .asm file, and the header of a folded block stands for every address of the block (cursor, scrolling, keys). */
import type { Addr, Block, ListingLine } from '@kickreasm/core';
import { fileLineNumbers } from './lines';

export interface ListingView {
  lines: ListingLine[];
  /** 1-based line in the .asm file for every view line (0 for the file bars) */
  lineNo: Int32Array;
  /** address -> index of the view line that shows it (a folded block's header for all its bytes), -1 for none */
  lineOf: Int32Array;
  /** view index of a folded header -> how many lines it hides */
  hidden: Map<number, number>;
}

export function foldLines(all: readonly ListingLine[], blocks: readonly Block[], folded: ReadonlySet<Addr>): ListingView {
  const nums = fileLineNumbers(all);
  const lines: ListingLine[] = [], no: number[] = [], hidden = new Map<number, number>(), foldedAt = new Map<number, Block>();
  let fold = -1; // view index of the folded header whose lines are being skipped
  all.forEach((l, i) => {
    if (l.k === 'hdr' || l.k === 'file') fold = -1;
    // the blank line after a block stays: it separates the folded header from the next block
    if (fold >= 0 && l.k !== 'blank') { hidden.set(fold, (hidden.get(fold) || 0) + 1); return; }
    if (l.k === 'hdr') { const b = blocks[l.blk]; if (b && folded.has(b.start)) { fold = lines.length; foldedAt.set(fold, b); } }
    lines.push(l); no.push(nums[i]);
  });
  const lineOf = new Int32Array(65536).fill(-1);
  lines.forEach((l, i) => {
    const b = foldedAt.get(i);
    const [s, e] = b ? [b.start, b.end] : 'n' in l && l.n > 0 ? [l.a, l.a + l.n] : [0, 0];
    for (let a = s; a < e && a < 65536; a++) if (lineOf[a] < 0) lineOf[a] = i;
  });
  return { lines, lineNo: Int32Array.from(no), lineOf, hidden };
}
