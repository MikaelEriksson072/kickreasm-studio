/* The parse for Brokkr's fast format (src/fast.ts), which costs whole bytes: position by position from the start, as
 * src/parse-brk.ts, keeping several ways to each position. A way is "after a match" or "in a literal run" (with the
 * run's length, as every 32 literals take a token more), each with the last offset, which a match may take again;
 * of each it keeps the cheapest of any offset, and up to `arrivals` more whose offset can be taken again soon. */
import type { Matches } from './match.ts';
import { LIT, MATCH, type Tokens } from './format.ts';
import { FAST_RUN, LONG, MID, newCost, repCost, REP, TINY } from './fast.ts';

export interface FastParseOptions { arrivals: number; allLens: number }

/** what tokens cost in bytes: a match at the last offset and at a new one (Infinity: none), the most literals a token
 * takes, and the lengths where a match's cost grows */
export interface FastModel { rep: (len: number) => number; fresh: (len: number, o: number) => number; run: number; edges: number[] }

/** a match of any length as tokens of up to 255 bytes, the ones after the first at the last offset */
const chained = (first: (len: number) => number) => (len: number): number => {
  if (len <= 255) return first(len);
  const rest = len - 255;
  return first(255) + Math.floor(rest / 255) * repCost(255) + (rest % 255 ? repCost(rest % 255) : 0);
};
/** the format's own costs (a function: src/fast.ts, which defines them, imports this module) */
const fastModel = (): FastModel => ({
  rep: chained(repCost), fresh: (len, o) => chained(l => newCost(l, o))(len), run: FAST_RUN,
  edges: [...[TINY, MID, LONG, REP].map(k => k.base + k.mask), 255, 256, 510, 511],
});

const INF = 0x3fffffff;

export function parseFast(d: Uint8Array, m: Matches, o: FastParseOptions, maxLen = 65535, model: FastModel = fastModel()): { tokens: Tokens; bytes: number } {
  const K = Math.max(1, o.arrivals), allLens = o.allLens;
  const n = d.length;
  // slots: 0 after a match (any offset), 1..K after a match (offsets that can be taken again soon), K+1 in a literal
  // run (any), K+2..2K+1 in a literal run (offsets that can be taken again here)
  const S = 2 * K + 2, MA = 0, M0 = 1, LA = K + 1, L0 = K + 2;
  const size = (n + 1) * S;
  const cost = new Int32Array(size).fill(INF);
  const soff = new Int32Array(size);
  const slen = new Int32Array(size);
  const bpos = new Int32Array(size);
  const bslot = new Uint8Array(size);
  const tkind = new Uint8Array(size);
  const tlen = new Int32Array(size);
  const set = (q: number, s: number, v: number, of: number, run: number, fp: number, fs: number, k: number, l: number) => {
    const i = q * S + s;
    cost[i] = v; soff[i] = of; slen[i] = run; bpos[i] = fp; bslot[i] = fs; tkind[i] = k; tlen[i] = l;
  };
  const repeats = (q: number, of: number) => q < n && of <= q && d[q] === d[q - of];
  const arrive = (q: number, any: number, first: number, v: number, of: number, run: number, canRep: boolean, fp: number, fs: number, k: number, l: number) => {
    const base = q * S;
    if (v < cost[base + any]) set(q, any, v, of, run, fp, fs, k, l);
    if (!canRep) return;
    let worst = -1, worstCost = -1;
    for (let s = first; s < first + K; s++) {
      const cs = cost[base + s];
      if (cs !== INF && soff[base + s] === of) { if (v < cs) set(q, s, v, of, run, fp, fs, k, l); return; }
      if (cs > worstCost) { worstCost = cs; worst = s; }
    }
    if (v < worstCost) set(q, worst, v, of, run, fp, fs, k, l);
  };
  // lengths above allLens: only where a length takes more bytes, and full ones
  const edgeList: number[] = [];
  for (const t of model.edges) edgeList.push(t - 1, t);
  const edges = Int32Array.from([...new Set(edgeList.filter(l => l > allLens && l <= maxLen))].sort((a, b) => a - b)), E = edges.length;
  const rlPos = new Int32Array(65536).fill(-1), rlLen = new Int32Array(65536);

  set(0, MA, 0, 1, 0, 0, 0, LIT, 0);
  for (let q = 0; q < n; q++) {
    const base = q * S;
    // a literal: a run starts after a match (a token and the byte), or grows by a byte (and a token every 128)
    for (let s = 0; s < S; s++) {
      const cs = cost[base + s];
      if (cs >= INF) continue;
      const of = soff[base + s], inRun = s >= LA, run = inRun ? slen[base + s] + 1 : 1;
      const v = cs + (inRun ? 1 + (run % model.run === 1 ? 1 : 0) : 2);
      arrive(q + 1, LA, L0, v, of, run, repeats(q + 1, of), q, s, LIT, 1);
    }

    // a match at a new offset: from the cheapest way here, the nearest offset for each length
    let mb = cost[base + MA], ms = MA;
    if (cost[base + LA] < mb) { mb = cost[base + LA]; ms = LA; }
    const ps = m.start[q], pe = m.start[q + 1], np = pe - ps;
    if (mb < INF && np > 0) {
      const lmax = Math.min(m.len[pe - 1], maxLen);
      let pi = 0, ei = 0;
      for (let l = 2; l <= lmax;) {
        while (m.len[ps + pi] < l) pi++;
        const of = m.off[ps + pi], c = model.fresh(l, of);
        if (c !== Infinity) arrive(q + l, MA, M0, mb + c, of, 0, repeats(q + l + 1, of), q, ms, MATCH, l);
        if (l < allLens) { l++; continue; }
        while (ei < E && edges[ei] <= l) ei++;
        let pj = pi;
        while (pj < np && m.len[ps + pj] <= l) pj++;
        const a = ei < E ? edges[ei] : 0x10000, b = pj < np ? m.len[ps + pj] : 0x10000;
        l = a < b ? a : b;
      }
    }

    // a match at the last offset, from a way whose offset repeats here
    for (const [first, any] of [[M0, MA], [L0, LA]]) {
      for (let s = first - 1; s < first + K; s++) {
        const slot = s < first ? any : s;
        const cs = cost[base + slot];
        if (cs >= INF) continue;
        const of = soff[base + slot];
        if (!repeats(q, of)) continue;
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
          arrive(q + l, MA, M0, cs + model.rep(l), of, 0, repeats(q + l + 1, of), q, slot, MATCH, l);
          if (l < allLens) { l++; continue; }
          while (ei < E && edges[ei] <= l) ei++;
          const a = ei < E ? edges[ei] : 0x10000;
          l = l < rl && a > rl ? rl : a;
        }
      }
    }
  }

  let bestS = 0;
  const end = n * S;
  for (let s = 0; s < S; s++) if (cost[end + s] < cost[end + bestS]) bestS = s;
  if (cost[end + bestS] >= INF) throw new Error('No parse reaches the end of the data.');
  const bytes = cost[end + bestS] + 1;
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
  return { tokens, bytes };
}
