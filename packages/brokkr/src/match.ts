/* Finding the matches at every position: for each length, the nearest earlier place that repeats at least that
 * many bytes. A binary tree of the earlier suffixes per two-byte prefix (as LZMA's bt2 match finder keeps them)
 * gives exactly these: the newest suffix sharing a prefix of any length lies on the search path, and the path
 * visits newer suffixes first, so the first one reaching a length has the smallest offset for it. */

export interface Matches {
  /** the pairs of position p are start[p] .. start[p + 1] - 1, by growing length (and growing offset) */
  start: Int32Array;
  len: Int32Array;
  off: Int32Array;
  /** the offset of the nearest earlier byte that is the same (a match of length 1), 0 for none */
  near: Int32Array;
}

export interface MatchOptions {
  /** the longest length to find */
  maxLen: number;
  /** the largest offset */
  maxOffset: number;
  /** the tree compares up to this many bytes; a longer match is followed on by comparing its bytes */
  nice: number;
  /** the deepest the search goes into the tree at a position (exact without a limit) */
  depth: number;
  /**
   * farther places per position that repeat as many bytes as the longest so far: with an encoding whose buckets
   * are not ever wider, a farther offset can be cheaper than the nearest
   */
  ties: number;
}

export const MATCH_DEFAULTS: MatchOptions = { maxLen: 65535, maxOffset: 65535, nice: 256, depth: 1 << 20, ties: 8 };

export function findMatches(d: Uint8Array, o: Partial<MatchOptions> = {}): Matches {
  const { maxLen, maxOffset, nice, depth, ties } = { ...MATCH_DEFAULTS, ...o };
  const n = d.length;
  const start = new Int32Array(n + 1);
  const near = new Int32Array(n);
  let cap = Math.max(1024, n * 4);
  let lens = new Int32Array(cap), offs = new Int32Array(cap), count = 0;
  const push = (len: number, off: number) => {
    if (count === cap) {
      cap *= 2;
      const l = new Int32Array(cap), f = new Int32Array(cap);
      l.set(lens); f.set(offs); lens = l; offs = f;
    }
    lens[count] = len; offs[count++] = off;
  };

  const son = new Int32Array(2 * n).fill(-1);
  const head = new Int32Array(65536).fill(-1);
  const last = new Int32Array(256).fill(-1);
  // the long match of the position before: its offset and length (a run goes on one byte shorter)
  let longOff = 0, longLen = 0;

  for (let p = 0; p < n; p++) {
    start[p] = count;
    const b = d[p];
    if (last[b] >= 0 && p - last[b] <= maxOffset) near[p] = p - last[b];
    last[b] = p;
    if (p + 1 >= n) { longLen = 0; continue; }

    const h = (b << 8) | d[p + 1];
    let cur = head[h];
    head[h] = p;
    const limit = Math.min(nice, n - p);
    let ptr0 = 2 * p + 1, ptr1 = 2 * p;
    let len0 = 2, len1 = 2, best = 1, left = depth, bestOff = 0, bestAt = -1, extra = 0;
    for (;;) {
      if (cur < 0 || left-- === 0 || p - cur > maxOffset) { son[ptr0] = -1; son[ptr1] = -1; break; }
      let len = len0 < len1 ? len0 : len1;
      while (len < limit && d[cur + len] === d[p + len]) len++;
      if (len > best) {
        best = len; bestOff = p - cur; bestAt = count;
        push(Math.min(len, maxLen), bestOff);
        if (len >= maxLen) { son[ptr1] = son[2 * cur]; son[ptr0] = son[2 * cur + 1]; break; }
      } else if (len === best && len >= 2 && extra < ties) { push(Math.min(len, maxLen), p - cur); extra++; }
      if (len >= limit) { son[ptr1] = son[2 * cur]; son[ptr0] = son[2 * cur + 1]; break; }
      if (d[cur + len] < d[p + len]) { son[ptr1] = cur; ptr1 = 2 * cur + 1; cur = son[ptr1]; len1 = len; }
      else { son[ptr0] = cur; ptr0 = 2 * cur; cur = son[ptr0]; len0 = len; }
    }

    // a match as long as the tree compares goes on: follow it, or the one of the position before
    let nextLong = 0, nextOff = 0;
    if (best >= nice && best < maxLen && n - p > nice) {
      let len: number;
      if (bestOff === longOff && longLen - 1 >= nice) len = Math.min(longLen - 1, maxLen);
      else { len = best; while (len < maxLen && p + len < n && d[p + len - bestOff] === d[p + len]) len++; }
      // the farther ones as long as the tree compares are no longer as long
      count = bestAt + 1;
      lens[bestAt] = len;
      nextLong = len; nextOff = bestOff;
      // the long match of the position before, one shorter, can reach further at its larger offset
      if (longOff !== bestOff && longLen - 1 > len) {
        nextLong = Math.min(longLen - 1, maxLen); nextOff = longOff;
        push(nextLong, nextOff);
      }
    }
    longLen = nextLong; longOff = nextOff;
  }
  start[n] = count;
  return { start, len: lens.subarray(0, count), off: offs.subarray(0, count), near };
}
