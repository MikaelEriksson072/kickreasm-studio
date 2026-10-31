/* Node-only: Brokkr's effort 'max' on a pool of worker threads, one per core but one. The worker script is the
 * caller's: one that calls serveBrokkr() (the desktop app bundles its own, electron/main/brokkr-worker.ts). */
import { crunchData, crunchSearch, PROFILES, protocol } from '@mimir/brokkr';
import { defaultThreads, Pool, serve } from '@mimir/brokkr/node';
import { packWithBrokkr, type BrokkrPack } from '../brokkr';
import type { PackPrefs } from '../types';

export { serve as serveBrokkr, defaultThreads as brokkrThreads };

/** Pack as packWithBrokkr does, with effort 'max' spread over `threads` workers running `workerFile`. */
export async function packWithBrokkrThreads(files: readonly { name: string; prg: Uint8Array }[], prefs: PackPrefs, workerFile: string | URL,
  threads = defaultThreads()): Promise<BrokkrPack> {
  if (prefs.effort !== 'max' || threads < 2) return packWithBrokkr(files, prefs);
  const pool = new Pool(threads, workerFile);
  try {
    return await packWithBrokkr(files, prefs, async (d, o) => (o.effort === 'max' && !o.encoding
      ? crunchSearch(d, o, pool.runner({ data: d, protocol: protocol(o.protocol), profile: { ...PROFILES.max, ...o.profile }, header: o.header !== false }))
      : crunchData(d, o)));
  } finally {
    await pool.close();
  }
}
