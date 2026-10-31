/* Node-only: a pool of worker threads for the thorough search, so effort 'max' uses every core. Each worker finds
 * the matches of a job once and then refines from the encodings it is given. `serve()` is a worker's whole body:
 * src/worker.ts calls it, and so can a worker file of a program that bundles Brokkr (Mimir Studio does). */
import { availableParallelism } from 'node:os';
import { parentPort, Worker } from 'node:worker_threads';
import { matchesFor } from './crunch.ts';
import type { Matches } from './match.ts';
import { runTask, type Job, type Runner, type Task, type TaskResult } from './search.ts';

interface TaskMessage { kind: 'brokkr-task'; job: number; id: number; data: Uint8Array; protocol: Job['protocol']; profile: Job['profile']; header: boolean; task: Task }
interface ResultMessage { kind: 'brokkr-result'; id: number; result?: TaskResult; error?: string }

/** Brokkr's own worker script (src/worker.ts). */
export const workerFile = new URL('./worker.ts', import.meta.url);

/** The threads a pool uses by default: all cores but one. */
export const defaultThreads = (): number => Math.max(1, availableParallelism() - 1);

export class Pool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: { msg: TaskMessage; resolve: (r: TaskResult) => void; reject: (e: Error) => void }[] = [];
  private readonly waiting = new Map<number, { resolve: (r: TaskResult) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private nextJob = 1;

  readonly size: number;
  private readonly file: string | URL;
  /** `file`: the worker script, which calls serve(): Brokkr's own is `workerFile`, a program that bundles Brokkr
   * has its own. */
  constructor(size = defaultThreads(), file: string | URL = workerFile) {
    this.size = size;
    this.file = file;
  }

  private spawn(): Worker {
    const w = new Worker(this.file, { workerData: { brokkr: true } });
    w.on('message', (m: ResultMessage) => {
      if (m?.kind !== 'brokkr-result') return;
      const p = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (m.error || !m.result) p?.reject(new Error(m.error ?? 'A worker returned nothing.'));
      else p?.resolve(m.result);
      this.idle.push(w);
      this.pump();
    });
    w.on('error', e => { for (const p of this.waiting.values()) p.reject(e as Error); this.waiting.clear(); });
    this.workers.push(w);
    return w;
  }

  private pump(): void {
    while (this.queue.length) {
      let w = this.idle.pop();
      if (!w && this.workers.length < this.size) w = this.spawn();
      if (!w) return;
      const t = this.queue.shift()!;
      this.waiting.set(t.msg.id, t);
      w.postMessage(t.msg);
    }
  }

  /** A runner for one job: its tasks go to the pool's threads. */
  runner(job: Job): Runner {
    const jobId = this.nextJob++;
    return {
      run: tasks => Promise.all(tasks.map(task => new Promise<TaskResult>((resolve, reject) => {
        const msg: TaskMessage = { kind: 'brokkr-task', job: jobId, id: this.nextId++, data: job.data, protocol: job.protocol, profile: job.profile, header: job.header, task };
        this.queue.push({ msg, resolve, reject });
        this.pump();
      }))),
    };
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map(w => w.terminate()));
    this.workers.length = 0;
    this.idle.length = 0;
  }
}

/** A worker's body: refine tasks as they come, keeping the matches of the last job. */
export function serve(port = parentPort): void {
  if (!port) throw new Error('serve() runs in a worker thread.');
  let cached: { job: number; m: Matches } | null = null;
  port.on('message', (msg: TaskMessage) => {
    if (msg?.kind !== 'brokkr-task') return;
    try {
      const job: Job = { data: msg.data, protocol: msg.protocol, profile: msg.profile, header: msg.header };
      if (cached?.job !== msg.job) cached = { job: msg.job, m: matchesFor(job.data, job.protocol, job.profile) };
      const result = runTask(job, cached.m, msg.task);
      port.postMessage({ kind: 'brokkr-result', id: msg.id, result } satisfies ResultMessage);
    } catch (e) {
      port.postMessage({ kind: 'brokkr-result', id: msg.id, error: (e as Error).message } satisfies ResultMessage);
    }
  });
}
