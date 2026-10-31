import { describe, expect, it } from 'vitest';
import { crunchData, PROFILES } from '../src/crunch.ts';
import { protocol } from '../src/format.ts';
import { Pool } from '../src/node.ts';
import { crunchSearch, neighbours } from '../src/search.ts';
import { programLike } from './tools.ts';

describe('the thorough search', () => {
  const data = programLike(4000, 21);

  it('changes one bucket by one bit at a time', () => {
    const e = crunchData(data).encoding;
    const n = neighbours(e);
    expect(n.length).toBeGreaterThan(80);
    for (const x of n) {
      const diff = [...x.len, ...x.off.flat()].map((b, i) => Math.abs(b - [...e.len, ...e.off.flat()][i])).reduce((a, b) => a + b);
      expect(diff).toBe(1);
    }
  });

  it('is never larger than effort normal', async () => {
    const normal = crunchData(data);
    const max = await crunchSearch(data, { effort: 'max' }, undefined, 1);
    expect(max.stream.length).toBeLessThanOrEqual(normal.stream.length);
  });

  it('finds the same on a pool of threads as here', async () => {
    const pool = new Pool(2);
    try {
      const job = { data, protocol: protocol(), profile: PROFILES.max, header: true };
      const threaded = await crunchSearch(data, { effort: 'max' }, pool.runner(job), 1);
      const here = await crunchSearch(data, { effort: 'max' }, undefined, 1);
      expect(threaded.stream).toEqual(here.stream);
    } finally {
      await pool.close();
    }
  });

  it('is quicker but a little larger with effort fast', () => {
    const fast = crunchData(data, { effort: 'fast' }), normal = crunchData(data);
    expect(fast.stream.length).toBeGreaterThanOrEqual(normal.stream.length);
  });
});
