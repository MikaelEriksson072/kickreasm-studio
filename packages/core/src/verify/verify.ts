/* Round trip: render -> assemble every file -> compare with the original PRG byte by byte.
 * Blocks left out of the build (RenderResult.excluded) are not compared: the output starts and ends at the first
 * and last byte that is built, and must not contain the excluded bytes (a gap Kick Assembler fills with zeros). */
import type { Addr, AnalysisResult, ExcludedRange, RenderResult, VerifyDiff, VerifyResult } from '../types';
import { h4 } from '../util/hex';
import { assemble } from './kick-subset-assembler';

interface Span { start: Addr; end: Addr }

/** what of a file is built: whether an address is left out, and the first/last built address (-1: nothing) */
function built(load: Addr, end: Addr, skip: readonly Span[]) {
  const out = (a: Addr) => skip.some(s => a >= s.start && a < s.end);
  let first = -1, last = -1, excluded = 0;
  for (let a = load; a < end; a++) { if (out(a)) excluded++; else { if (first < 0) first = a; last = a; } }
  return { out, first, last, excluded };
}

export function verify(A: AnalysisResult, R: RenderResult): VerifyResult {
  const results = A.files.map((f, fi) => {
    const path = `${R.fileNames[fi]}.asm`;
    const asm = assemble(R.files, path);
    const end = Math.min(0x10000, f.load + f.bytes.length);
    const b = built(f.load, end, (R.excluded || []).filter((x: ExcludedRange) => x.file === fi));
    const diffs: VerifyDiff[] = [];
    let same = 0;
    if (asm.min !== b.first) diffs.push({ addr: asm.min, msg: `output starts at $${h4(Math.max(0, asm.min))}, original at $${h4(b.first)}` });
    if (asm.max !== b.last) diffs.push({ addr: asm.max, msg: `output ends at $${h4(Math.max(0, asm.max))}, original at $${h4(b.last)}` });
    for (let a = f.load; a < end; a++) {
      if (b.out(a)) { if (asm.written[a] && diffs.length < 40) diffs.push({ addr: a, msg: `$${h4(a)} is in a block left out of the build but was assembled` }); continue; }
      if (asm.mem[a] === f.bytes[a - f.load] && asm.written[a]) same++;
      else if (diffs.length < 40) diffs.push({ addr: a, exp: f.bytes[a - f.load], got: asm.written[a] ? asm.mem[a] : null });
    }
    return { file: f.name, path, ok: !asm.errors.length && !diffs.length, same, total: end - f.load - b.excluded, diffs, errors: asm.errors, prg: asm.prg, blocks: asm.blocks, excluded: b.excluded };
  });
  return { ok: results.every(r => r.ok), results };
}

/**
 * Compare a PRG produced by an external assembler (KickAss.jar) with the original file, leaving out the
 * `skip` ranges (blocks excluded from the build). Same diff format as `verify()`.
 */
export function comparePrg(original: { load: number; bytes: Uint8Array }, prg: Uint8Array | null, skip: readonly Span[] = []): { ok: boolean; same: number; total: number; excluded: number; diffs: VerifyDiff[] } {
  const end = Math.min(0x10000, original.load + original.bytes.length);
  const b = built(original.load, end, skip);
  const total = end - original.load - b.excluded;
  const diffs: VerifyDiff[] = [];
  if (b.first < 0) return { ok: !prg || prg.length <= 2, same: 0, total, excluded: b.excluded, diffs: prg && prg.length > 2 ? [{ addr: original.load, msg: 'every block is left out of the build, but there is output' }] : [] };
  if (!prg || prg.length < 2) return { ok: false, same: 0, total, excluded: b.excluded, diffs: [{ addr: original.load, msg: 'no output file' }] };
  const load = prg[0] | (prg[1] << 8), last = load + prg.length - 3;
  if (load !== b.first) diffs.push({ addr: load, msg: `output starts at $${h4(load)}, original at $${h4(b.first)}` });
  if (last !== b.last) diffs.push({ addr: last, msg: `output ends at $${h4(Math.max(0, last))}, original at $${h4(b.last)}` });
  let same = 0;
  for (let a = original.load; a < end; a++) {
    if (b.out(a)) continue; // a gap there is filled with zeros
    const i = a - load + 2;
    const got = i >= 2 && i < prg.length ? prg[i] : null;
    if (got === original.bytes[a - original.load]) same++;
    else if (diffs.length < 40) diffs.push({ addr: a, exp: original.bytes[a - original.load], got });
  }
  return { ok: !diffs.length, same, total, excluded: b.excluded, diffs };
}
