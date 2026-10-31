/* The parse for Brokkr's own format (src/brk.ts), with its prices: as src/parse.ts, position by position from the
 * start, keeping several ways to each position. The states differ from Exomizer's: the last match's offset stays
 * takeable after any number of literals, so a way to a position is "after a match" or "after a literal", each with
 * the offset a rep would take. Of each it keeps the best of any offset, and up to `arrivals` more whose offset can
 * be taken again here (the bytes here repeat at it). */
import type { Matches } from './match.ts';
import { LIT, MATCH, type Tokens } from './format.ts';
import { lenPrice, offPrice, repLenPrice, type BrkPrices } from './brk.ts';

export interface BrkParseOptions { arrivals: number; allLens: number }

const INF = 0x3fffffff;

/** `blocks`: the prices where each block of `1 << shift` bytes starts (one block: the same prices everywhere) */
export function parseBrk(d: Uint8Array, m: Matches, blocks: BrkPrices[], shift: number, o: BrkParseOptions, maxLen = 65535): { tokens: Tokens; price: number } {
  const K = o.arrivals, allLens = o.allLens;
  const n = d.length;
  // slots: 0 after a match (any offset), 1..K after a match (offsets that can be taken again soon), K+1 after a
  // literal (any), K+2..2K+1 after a literal (offsets that can be taken again here)
  const S = 2 * K + 2, MA = 0, M0 = 1, LA = K + 1, L0 = K + 2;
  const size = (n + 1) * S;
  const cost = new Int32Array(size).fill(INF);
  const soff = new Int32Array(size);
  const bpos = new Int32Array(size);
  const bslot = new Uint8Array(size);
  const tkind = new Uint8Array(size);
  const tlen = new Int32Array(size);
  const set = (q: number, s: number, v: number, of: number, fp: number, fs: number, k: number, l: number) => {
    const i = q * S + s;
    cost[i] = v; soff[i] = of; bpos[i] = fp; bslot[i] = fs; tkind[i] = k; tlen[i] = l;
  };
  const repeats = (q: number, of: number) => of > 0 && q < n && of <= q && d[q] === d[q - of];
  /** an arrival with a rep offset: the best of any, and a slot of its own when the offset can be taken again */
  const arrive = (q: number, any: number, first: number, v: number, of: number, canRep: boolean, fp: number, fs: number, k: number, l: number) => {
    const base = q * S;
    if (v < cost[base + any]) set(q, any, v, of, fp, fs, k, l);
    if (!canRep || K === 0) return;
    let worst = -1, worstCost = -1;
    for (let s = first; s < first + K; s++) {
      const cs = cost[base + s];
      if (cs !== INF && soff[base + s] === of) { if (v < cs) set(q, s, v, of, fp, fs, k, l); return; }
      if (cs > worstCost) { worstCost = cs; worst = s; }
    }
    if (v < worstCost) set(q, worst, v, of, fp, fs, k, l);
  };
  // lengths above allLens: only powers of two either side (where the length's bit count changes) and full lengths
  const edgeList: number[] = [];
  for (let b = 1; b < 16; b++) for (const l of [(1 << b) - 1, 1 << b]) if (l > allLens && l <= maxLen) edgeList.push(l);
  const edges = Int32Array.from([...new Set(edgeList)].sort((a, b) => a - b)), E = edges.length;
  const rlPos = new Int32Array(65536).fill(-1), rlLen = new Int32Array(65536);
  let most = 0;
  for (let q = 0; q < n; q++) most = Math.max(most, m.start[q + 1] - m.start[q]);
  const sufC = new Int32Array(most), sufO = new Int32Array(most);

  set(0, LA, 0, 1, 0, 0, LIT, 0);
  for (let q = 0; q < n; q++) {
    const pr = blocks[Math.min(blocks.length - 1, q >> shift)];
    const base = q * S, b = d[q];
    // a literal: after it the rep offset is the same
    const nb = q + 1;
    for (let s = 0; s < S; s++) {
      const cs = cost[base + s];
      if (cs >= INF) continue;
      const of = soff[base + s];
      const v = cs + (s < LA ? pr.litAfterMatch[b] : pr.litAfterLit[b]);
      arrive(nb, LA, L0, v, of, repeats(nb, of), q, s, LIT, 1);
    }

    // a match with an offset of its own: after a match, or after a literal (with the not-a-rep bit when there is
    // an offset to take)
    let mb = cost[base + MA] < INF ? cost[base + MA] + pr.matchAfterMatch : INF, ms = MA;
    const cla = cost[base + LA];
    if (cla < INF) { const v = cla + pr.matchAfterLit; if (v < mb) { mb = v; ms = LA; } }
    const ps = m.start[q], pe = m.start[q + 1], np = pe - ps;
    if (mb < INF && (np > 0 || m.near[q] > 0)) {
      let cl = INF, ol = 0, c2 = INF, o2 = 0, c1 = INF, o1 = 0;
      for (let i = np - 1; i >= 0; i--) {
        const of = m.off[ps + i];
        let v = offPrice(pr, 2, of); if (v <= cl) { cl = v; ol = of; }
        sufC[i] = cl; sufO[i] = ol;
        v = offPrice(pr, 1, of); if (v <= c2) { c2 = v; o2 = of; }
        v = offPrice(pr, 0, of); if (v <= c1) { c1 = v; o1 = of; }
      }
      const nr = m.near[q];
      if (nr > 0) { const v = offPrice(pr, 0, nr); if (v <= c1) { c1 = v; o1 = nr; } }
      const lmax = np > 0 ? Math.min(m.len[pe - 1], maxLen) : 1;
      let pi = 0, ei = 0;
      for (let l = 1; l <= lmax;) {
        let of: number, oc: number;
        if (l === 1) { of = o1; oc = c1; }
        else if (l === 2) { of = o2; oc = c2; }
        else { while (m.len[ps + pi] < l) pi++; of = sufO[pi]; oc = sufC[pi]; }
        if (oc < INF) {
          const t = q + l;
          arrive(t, MA, M0, mb + lenPrice(pr, l) + oc, of, t + 1 < n && repeats(t + 1, of), q, ms, MATCH, l);
        }
        if (l < allLens) { l++; continue; }
        while (ei < E && edges[ei] <= l) ei++;
        while (pi < np && m.len[ps + pi] <= l) pi++;
        const a = ei < E ? edges[ei] : 0x10000, c = pi < np ? m.len[ps + pi] : 0x10000;
        l = a < c ? a : c;
      }
    }

    // reps: after a literal whose rep offset repeats here
    for (let s = L0; s < L0 + K; s++) {
      const cs = cost[base + s];
      if (cs >= INF) continue;
      const of = soff[base + s];
      let rl: number;
      const at = rlPos[of];
      if (at >= 0 && q - at < rlLen[of]) rl = rlLen[of] - (q - at);
      else {
        rl = 0;
        while (q + rl < n && d[q + rl] === d[q + rl - of]) rl++;
        rlPos[of] = q; rlLen[of] = rl;
      }
      if (rl > maxLen) rl = maxLen;
      let ei = 0;
      for (let l = 1; l <= rl;) {
        const t = q + l;
        arrive(t, MA, M0, cs + pr.rep + repLenPrice(pr, l), of, t + 1 < n && repeats(t + 1, of), q, s, MATCH, l);
        if (l < allLens) { l++; continue; }
        while (ei < E && edges[ei] <= l) ei++;
        const a = ei < E ? edges[ei] : 0x10000;
        l = l < rl && a > rl ? rl : a;
      }
    }
  }

  let bestS = 0;
  const end = n * S;
  for (let s = 0; s < S; s++) if (cost[end + s] < cost[end + bestS]) bestS = s;
  if (cost[end + bestS] >= INF) throw new Error('No parse reaches the end of the data.');
  const price = cost[end + bestS] + blocks[blocks.length - 1].end;
  const kinds: number[] = [], lens: number[] = [], offs: number[] = [];
  let q = n, s = bestS;
  while (q > 0) {
    const i = q * S + s;
    kinds.push(tkind[i]); lens.push(tlen[i]); offs.push(tkind[i] === MATCH ? soff[i] : 0);
    q = bpos[i]; s = bslot[i];
  }
  const count = kinds.length;
  const tokens: Tokens = { kind: new Uint8Array(count), len: new Int32Array(count), off: new Int32Array(count), count };
  for (let i = 0; i < count; i++) {
    tokens.kind[i] = kinds[count - 1 - i]; tokens.len[i] = lens[count - 1 - i]; tokens.off[i] = offs[count - 1 - i];
  }
  return { tokens, price };
}
