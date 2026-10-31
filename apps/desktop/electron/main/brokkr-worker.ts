/* A worker thread that packs with Brokkr (spec 13.8), so the main process stays free while it crunches. Started
 * with a pack request it answers once; started with { brokkr: true } it is one of the threads of the pool that
 * effort 'max' spreads its search over (it runs this same file). */
import { parentPort, workerData } from 'node:worker_threads';
import { brokkrThreads, packWithBrokkrThreads, serveBrokkr } from '@mimir/core/node';
import type { PackRequest } from '../../shared/ipc';

if (workerData?.brokkr) serveBrokkr();
else {
  parentPort!.once('message', async (req: PackRequest) => {
    try {
      parentPort!.postMessage({ ok: true, result: await packWithBrokkrThreads(req.files, req.prefs, __filename, brokkrThreads()) });
    } catch (e) {
      parentPort!.postMessage({ ok: false, error: (e as Error).message });
    }
  });
}
