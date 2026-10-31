/* The encoding for a parse: the bits of each bucket of the length table and the offset tables that make the
 * parse's matches cheapest. The same search as Exomizer's: bucket by bucket from the smallest value, each either
 * as wide as it pays, with the next one after it, or leaving the values above uncovered (the matches that need them
 * then cost what their bytes cost as literals). Unlike Exomizer it counts only the offsets that are written: a match
 * that takes the offset again has none. */
import { LITERAL_BITS, MATCH, TABLE_BITS, reuses, tableCount, tableOf, tableSize, type Encoding, type Tokens } from './format.ts';

const SPAN = 65538;
let fBuf = new Float64Array(0);
let bBuf = new Int8Array(0);

/**
 * The best buckets for values with these counts. `cum[v]`: how many values are v or more; `skip[v]` what leaving
 * values v and up uncovered costs (null: they must be covered). `prefix(depth)`: the bits of a bucket's index.
 * f(depth, start), the least cost of the values from start up with the buckets from depth on, is filled in from
 * the deepest bucket up.
 */
function buckets(cum: Float64Array, skip: Float64Array | null, count: number, prefix: (depth: number) => number): number[] {
  let top = 0;
  for (let v = SPAN - 2; v > 0; v--) if (cum[v] > 0) { top = v; break; }
  const w = top + 2;
  if (fBuf.length < w * count) { fBuf = new Float64Array(SPAN * 16); bBuf = new Int8Array(SPAN * 16); }
  const f = fBuf, choice = bBuf;
  for (let depth = count - 1; depth >= 0; depth--) {
    const row = depth * w, next = (depth + 1) * w, pre = prefix(depth), deeper = depth + 1 < count;
    f[row + top + 1] = 0;
    for (let s = top; s >= 1; s--) {
      const cs = cum[s];
      if (cs === 0) { f[row + s] = 0; choice[row + s] = 0; continue; }
      let best = Infinity, bestBits = 0;
      for (let b = 0; b < 16; b++) {
        const e = s + (1 << b);
        const ce = e <= top ? cum[e] : 0;
        let v = (cs - ce) * (pre + b);
        if (ce > 0) {
          let rest = skip ? skip[e] : Infinity;
          if (deeper) { const g = f[next + e]; if (g < rest) rest = g; }
          v += rest;
        }
        if (v < best) { best = v; bestBits = b; }
        if (ce === 0) break;
      }
      f[row + s] = best; choice[row + s] = bestBits;
    }
  }
  const out: number[] = [];
  let start = 1;
  for (let depth = 0; depth < count; depth++) {
    if (start > top) { out.push(0); continue; }
    const b = choice[depth * w + start];
    out.push(b);
    start += 1 << b;
  }
  return out;
}

/** The encoding that makes a parse cheapest. */
export function encodingFor(t: Tokens, flags: number): Encoding {
  const reuse = reuses(t, flags);
  const lenCount = new Float64Array(SPAN);
  for (let i = 0; i < t.count; i++) if (t.kind[i] === MATCH) lenCount[t.len[i]]++;
  for (let v = SPAN - 2; v >= 0; v--) lenCount[v] += lenCount[v + 1];
  const len = buckets(lenCount, null, 16, d => d + 1);

  // what a match's offset may cost before its bytes are cheaper as literals, with the new length table
  const lenCost = new Int32Array(65536).fill(1 << 20);
  {
    let base = 1;
    for (let g = 0; g < 16; g++) { const end = Math.min(65536, base + (1 << len[g])); for (let l = base; l < end; l++) lenCost[l] = g + 1 + len[g]; base = end; }
  }
  const n = tableCount(flags);
  const off: number[][] = [];
  for (let tb = 0; tb < n; tb++) {
    const cum = new Float64Array(SPAN), skip = new Float64Array(SPAN);
    for (let i = 0; i < t.count; i++) {
      if (t.kind[i] !== MATCH || reuse[i] || tableOf(t.len[i], flags) !== tb) continue;
      cum[t.off[i]]++;
      skip[t.off[i]] += Math.max(0, LITERAL_BITS * t.len[i] - 1 - lenCost[t.len[i]]);
    }
    for (let v = SPAN - 2; v >= 0; v--) { cum[v] += cum[v + 1]; skip[v] += skip[v + 1]; }
    off[tb] = buckets(cum, skip, tableSize(tb), () => TABLE_BITS[tb]);
  }
  return { len, off };
}

/** Whether an encoding can write every match of a parse. */
export function covers(e: Encoding, t: Tokens, flags: number): boolean {
  const reuse = reuses(t, flags);
  const top = (bits: number[]) => bits.reduce((a, b) => a + (1 << b), 1);
  const lenTop = top(e.len), offTop = e.off.map(top);
  for (let i = 0; i < t.count; i++) {
    if (t.kind[i] !== MATCH) continue;
    if (t.len[i] >= lenTop) return false;
    if (!reuse[i] && t.off[i] >= offTop[tableOf(t.len[i], flags)]) return false;
  }
  return true;
}
