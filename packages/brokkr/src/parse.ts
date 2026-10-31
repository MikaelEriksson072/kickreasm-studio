/* The parse: the cheapest way to write the data as literals, literal sequences and matches with an encoding's
 * costs, found position by position from the start (the order the decruncher writes).
 *
 * Exomizer keeps one way to reach each position. The cost of a match depends on what came before it, though: after a
 * match and one literal the decruncher reads a bit that may take the match's offset again, so that state pays a bit
 * for every match and saves the offset of one. Brokkr keeps several ways to reach each position, one per state and
 * offset that can still be taken again:
 *  - N: after two literals (or at the start): a match pays no reuse bit;
 *  - M(o): after a match with offset o: a literal leads to R(o);
 *  - R(o): after a match with offset o and one literal: the next match pays the reuse bit and may take o for free.
 * Of M and R it keeps the best arrival of any offset, and up to `arrivals` more whose offset can be taken again
 * right away (the bytes after the literal repeat at that offset). */
import type { Matches } from './match.ts';
import { END_BITS, INF, LIT, LITERAL_BITS, MATCH, P, SEQ, SEQ_BITS, T, type Costs, type Protocol, type Tokens } from './format.ts';

export interface ParseOptions {
  /** the extra M and R arrivals kept per position (0: one way per state) */
  arrivals: number;
  /** every length up to this is tried; a longer match tries the ends of the length buckets and its full length */
  allLens: number;
}

export const PARSE_DEFAULTS: ParseOptions = { arrivals: 4, allLens: 64 };

export interface Parse { tokens: Tokens; bits: number }

export function parse(d: Uint8Array, m: Matches, c: Costs, p: Protocol, o: Partial<ParseOptions> = {}): Parse {
  const { arrivals: K, allLens } = { ...PARSE_DEFAULTS, ...o };
  const n = d.length;
  const flags = p.flags;
  const reuseOn = (flags & P.REUSE) !== 0;
  // the reuse bit a match pays in R
  const rbit = reuseOn ? 1 : 0;
  const seqOn = !(p.traits & T.NO_LIT_SEQ);
  const mirrors = (p.traits & T.NO_MIRRORS) !== 0;
  const maxSeq = Math.min(p.maxLen, 65535);
  // slots: 0 N, 1 M any, 2..K+1 M(o), K+2 R any, K+3..2K+2 R(o)
  const S = 2 * K + 3, MA = 1, M0 = 2, RA = K + 2, R0 = K + 3;
  const size = (n + 1) * S;
  const cost = new Int32Array(size).fill(INF);
  const soff = new Int32Array(size);
  const bpos = new Int32Array(size);
  const bslot = new Uint8Array(size);
  const tkind = new Uint8Array(size);
  const tlen = new Int32Array(size);
  const lenC = c.len, off0 = c.off[0], off1 = c.off[1], offT = c.off;
  const four = (flags & P.FOUR_TABLES) !== 0;
  const offLong = c.off[four ? 3 : 2];

  // the first and last lengths of the length buckets above allLens: of a longer match only these (and its full
  // length) are tried
  const edgeList: number[] = [];
  for (let l = allLens + 1; l <= 65535; l++) {
    if (lenC[l] >= INF) continue;
    if (lenC[l] !== lenC[l - 1] || l === 65535 || lenC[l] !== lenC[l + 1]) edgeList.push(l);
  }
  const edges = Int32Array.from(edgeList), E = edges.length;
  // where the repeat at an offset was last counted, and how long it was there
  const rlPos = new Int32Array(65536).fill(-1), rlLen = new Int32Array(65536);
  // the cheapest offsets of a position's pairs from each pair on, for the longest table and the one of length 3
  let most = 0;
  for (let q = 0; q < n; q++) most = Math.max(most, m.start[q + 1] - m.start[q]);
  const sufC = new Int32Array(most), sufO = new Int32Array(most), suf3C = new Int32Array(most), suf3O = new Int32Array(most);

  const set = (q: number, s: number, v: number, of: number, fp: number, fs: number, k: number, l: number): void => {
    const i = q * S + s;
    cost[i] = v; soff[i] = of; bpos[i] = fp; bslot[i] = fs; tkind[i] = k; tlen[i] = l;
  };
  /** an arrival in a state with an offset: the best of any offset, and a slot of its own when it can reuse */
  const arrive = (q: number, any: number, first: number, v: number, of: number, canReuse: boolean,
    fp: number, fs: number, k: number, l: number): void => {
    const base = q * S;
    if (v < cost[base + any]) set(q, any, v, of, fp, fs, k, l);
    if (!canReuse || K === 0) return;
    let worst = -1, worstCost = -1;
    for (let s = first; s < first + K; s++) {
      const cs = cost[base + s];
      if (cs !== INF && soff[base + s] === of) { if (v < cs) set(q, s, v, of, fp, fs, k, l); return; }
      if (cs > worstCost) { worstCost = cs; worst = s; }
    }
    if (v < worstCost) set(q, worst, v, of, fp, fs, k, l);
  };
  // a literal after M(o) at q - 1 leads to R(o) at q, which can reuse when the byte at q repeats at o
  const reuseAt = (q: number, of: number): boolean => reuseOn && q < n && of <= q && d[q] === d[q - of];

  let from = 0;
  if (flags & P.IMPL_LIT) {
    if (n === 0) throw new Error('There is nothing to crunch: the data is empty.');
    set(1, 0, 8, 0, 0, 0, LIT, 1);
    from = 1;
  } else set(0, 0, 0, 0, 0, 0, LIT, 0);

  // literal sequences: the cheapest start (cost - 8 * position) within the longest sequence, from N/R and from M
  const dqN = new Int32Array(n + 1), dqM = new Int32Array(n + 1);
  const dqNs = new Uint8Array(n + 1);
  let hN = 0, tN = 0, hM = 0, tM = 0;

  for (let q = from; q <= n; q++) {
    const base = q * S;
    if (seqOn && q > from) {
      while (hN < tN && q - dqN[hN] > maxSeq) hN++;
      while (hM < tM && q - dqM[hM] > maxSeq) hM++;
      if (hN < tN) {
        const sp = dqN[hN], ss = dqNs[hN], len = q - sp;
        if (len > 1 && !(mirrors && len > 255 && (len & 255) === 0)) {
          const v = cost[sp * S + ss] + SEQ_BITS + 8 * len;
          if (v < cost[base]) set(q, 0, v, 0, sp, ss, SEQ, len);
        }
      }
      if (hM < tM) {
        const sp = dqM[hM], len = q - sp;
        if (len > 1 && !(mirrors && len > 255 && (len & 255) === 0)) {
          const i = sp * S + MA, of = soff[i];
          arrive(q, RA, R0, cost[i] + SEQ_BITS + 8 * len, of, reuseAt(q, of), sp, MA, SEQ, len);
        }
      }
    }
    if (q === n) break;

    const cN = cost[base], cMA = cost[base + MA], cRA = cost[base + RA];
    if (seqOn) {
      // push this position as a sequence start (its best of N and R; and its best M)
      const useR = cRA < cN, vN = useR ? cRA : cN;
      if (vN < INF) {
        const key = vN - 8 * q;
        while (tN > hN && cost[dqN[tN - 1] * S + dqNs[tN - 1]] - 8 * dqN[tN - 1] >= key) tN--;
        dqN[tN] = q; dqNs[tN++] = useR ? RA : 0;
      }
      if (cMA < INF) {
        const key = cMA - 8 * q;
        while (tM > hM && cost[dqM[tM - 1] * S + MA] - 8 * dqM[tM - 1] >= key) tM--;
        dqM[tM++] = q;
      }
    }

    // a literal
    const nb = base + S;
    {
      const useR = cRA < cN, v = (useR ? cRA : cN) + LITERAL_BITS;
      if (v < cost[nb]) set(q + 1, 0, v, 0, q, useR ? RA : 0, LIT, 1);
      if (cMA < INF) { const of = soff[base + MA]; arrive(q + 1, RA, R0, cMA + LITERAL_BITS, of, reuseAt(q + 1, of), q, MA, LIT, 1); }
      for (let s = M0; s < M0 + K; s++) {
        const cs = cost[base + s];
        if (cs < INF) arrive(q + 1, RA, R0, cs + LITERAL_BITS, soff[base + s], true, q, s, LIT, 1);
      }
    }

    // matches with an offset of their own: from N or M without the reuse bit, or from R with it
    let mb = cN, ms = 0;
    if (cMA < mb) { mb = cMA; ms = MA; }
    if (cRA + rbit < mb) { mb = cRA + rbit; ms = RA; }
    const ps = m.start[q], pe = m.start[q + 1], np = pe - ps;
    if (mb < INF && (np > 0 || m.near[q] > 0)) {
      // the cheapest offset of the places that repeat at least l bytes: the pairs grow in length, so for the
      // longer tables a minimum over the pairs from the first one long enough; on equal cost the nearer one
      let c1 = INF, o1 = 0, c2 = INF, o2 = 0, cl = INF, ol = 0, c3 = INF, o3 = 0;
      for (let i = np - 1; i >= 0; i--) {
        const of = m.off[ps + i];
        let v = offLong[of]; if (v <= cl) { cl = v; ol = of; }
        sufC[i] = cl; sufO[i] = ol;
        if (four) { v = offT[2][of]; if (v <= c3) { c3 = v; o3 = of; } suf3C[i] = c3; suf3O[i] = o3; }
        v = off1[of]; if (v <= c2) { c2 = v; o2 = of; }
        v = off0[of]; if (v <= c1) { c1 = v; o1 = of; }
      }
      const nr = m.near[q];
      if (nr > 0 && off0[nr] <= c1) { c1 = off0[nr]; o1 = nr; }
      const lmax = np > 0 ? m.len[pe - 1] : 1;
      let pi = 0, ei = 0;
      for (let l = 1; l <= lmax;) {
        let of: number, oc: number;
        if (l === 1) { of = o1; oc = c1; }
        else if (l === 2) { of = o2; oc = c2; }
        else {
          while (m.len[ps + pi] < l) pi++;
          if (four && l === 3) { of = suf3O[pi]; oc = suf3C[pi]; } else { of = sufO[pi]; oc = sufC[pi]; }
        }
        const lc = lenC[l];
        if (oc < INF && lc < INF) {
          const t = q + l;
          arrive(t, MA, M0, mb + 1 + lc + oc, of, t < n && reuseAt(t + 1, of), q, ms, MATCH, l);
        }
        if (l < allLens) { l++; continue; }
        // above allLens: the next bucket edge or the next pair's full length
        while (ei < E && edges[ei] <= l) ei++;
        while (pi < np && m.len[ps + pi] <= l) pi++;
        const a = ei < E ? edges[ei] : 0x10000, b = pi < np ? m.len[ps + pi] : 0x10000;
        l = a < b ? a : b;
      }
    }

    // matches that take the offset again: from each R(o) whose bytes repeat at o
    if (reuseOn) for (let s = R0; s < R0 + K; s++) {
      const cs = cost[base + s];
      if (cs >= INF) continue;
      const of = soff[base + s];
      // how far the bytes repeat at the offset: one less than at the position before, or counted
      let rl: number;
      const at = rlPos[of];
      if (at >= 0 && q - at < rlLen[of]) rl = rlLen[of] - (q - at);
      else {
        rl = 0;
        while (q + rl < n && d[q + rl] === d[q + rl - of]) rl++;
        rlPos[of] = q; rlLen[of] = rl;
      }
      if (rl > p.maxLen) rl = p.maxLen;
      let ei = 0;
      for (let l = 1; l <= rl;) {
        const lc = lenC[l];
        if (lc < INF) {
          const t = q + l;
          arrive(t, MA, M0, cs + 2 + lc, of, t < n && reuseAt(t + 1, of), q, s, MATCH, l);
        }
        if (l < allLens) { l++; continue; }
        while (ei < E && edges[ei] <= l) ei++;
        const a = ei < E ? edges[ei] : 0x10000;
        l = l < rl && a > rl ? rl : a;
      }
    }
  }

  // the cheapest way to the end, back to the start
  let bestS = 0;
  const end = n * S;
  for (let s = 0; s < S; s++) if (cost[end + s] < cost[end + bestS]) bestS = s;
  if (cost[end + bestS] >= INF) throw new Error('No parse reaches the end of the data with this encoding.');
  const bits = cost[end + bestS] + END_BITS;
  const kinds: number[] = [], lens: number[] = [], offs: number[] = [];
  let q = n, s = bestS;
  while (q > from) {
    const i = q * S + s;
    kinds.push(tkind[i]); lens.push(tlen[i]); offs.push(tkind[i] === MATCH ? soff[i] : 0);
    q = bpos[i]; s = bslot[i];
  }
  if (from === 1) { kinds.push(LIT); lens.push(1); offs.push(0); }
  const count = kinds.length;
  const tokens: Tokens = { kind: new Uint8Array(count), len: new Int32Array(count), off: new Int32Array(count), count };
  for (let i = 0; i < count; i++) {
    tokens.kind[i] = kinds[count - 1 - i]; tokens.len[i] = lens[count - 1 - i]; tokens.off[i] = offs[count - 1 - i];
  }
  return { tokens, bits };
}

/** A quick parse for a first encoding: the longest match where it is at least 2 long, else a literal. */
export function greedy(d: Uint8Array, m: Matches, p: Protocol): Tokens {
  const kinds: number[] = [], lens: number[] = [], offs: number[] = [];
  let q = 0;
  if (p.flags & P.IMPL_LIT && d.length) { kinds.push(LIT); lens.push(1); offs.push(0); q = 1; }
  while (q < d.length) {
    const pe = m.start[q + 1];
    if (pe > m.start[q] && m.len[pe - 1] >= 2) {
      const l = m.len[pe - 1];
      kinds.push(MATCH); lens.push(l); offs.push(m.off[pe - 1]); q += l;
    } else { kinds.push(LIT); lens.push(1); offs.push(0); q++; }
  }
  return { kind: Uint8Array.from(kinds), len: Int32Array.from(lens), off: Int32Array.from(offs), count: kinds.length };
}

/**
 * A first parse as Exomizer starts from: the longest match unless the next position has a longer one, otherwise
 * a match of length 1 when the byte is near (up to 34 back), otherwise a literal. It uses the short matches a
 * greedy parse leaves out, so the encoding made from it has room for them.
 */
export function lazy(d: Uint8Array, m: Matches, p: Protocol): Tokens {
  const kinds: number[] = [], lens: number[] = [], offs: number[] = [];
  const longest = (q: number) => (q < d.length && m.start[q + 1] > m.start[q] ? m.start[q + 1] - 1 : -1);
  let q = 0;
  if (p.flags & P.IMPL_LIT && d.length) { kinds.push(LIT); lens.push(1); offs.push(0); q = 1; }
  while (q < d.length) {
    const a = longest(q), b = longest(q + 1);
    const la = a >= 0 ? m.len[a] : 0, lb = b >= 0 ? m.len[b] : 0;
    if (la >= 2 && la >= lb + ((q & 1) && lb < 3 ? 1 : 0)) { kinds.push(MATCH); lens.push(la); offs.push(m.off[a]); q += la; }
    else if (m.near[q] > 0 && m.near[q] <= 34 && !(p.traits & T.NO_LEN1)) { kinds.push(MATCH); lens.push(1); offs.push(m.near[q]); q++; }
    else { kinds.push(LIT); lens.push(1); offs.push(0); q++; }
  }
  return { kind: Uint8Array.from(kinds), len: Int32Array.from(lens), off: Int32Array.from(offs), count: kinds.length };
}

