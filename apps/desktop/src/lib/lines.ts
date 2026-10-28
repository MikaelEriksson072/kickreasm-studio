/* Line numbers for the listing. The listing is every file's lines in order, each file after a 'file'
 * separator, and each file's .asm text is exactly those lines, so line n of the listing's file part is
 * line n of the .asm file (what Kick Assembler reports in errors and the source view shows). */
import type { ListingLine } from '@mimir/core';

/** 1-based line number in its .asm file for every listing line; 0 for the 'file' separators */
export function fileLineNumbers(lines: readonly ListingLine[]): Int32Array {
  const out = new Int32Array(lines.length);
  let n = 0;
  lines.forEach((l, i) => { if (l.k === 'file') n = 0; else out[i] = ++n; });
  return out;
}
