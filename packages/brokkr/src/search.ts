/* The thorough search behind effort 'max': parse and encoding from several starts, then a local search that
 * widens or narrows each bucket of the best encoding by a bit and refines from there, as long as the stream
 * shrinks. Every start is a task of its own, so they run in parallel when there are threads to run them on
 * (src/node.ts); without, they run one after the other. */
import { finish, matchesFor, PROFILES, refine, type CrunchOptions, type Crunched, type Profile } from './crunch.ts';
import { protocol, type Encoding, type Protocol, type Tokens } from './format.ts';
import type { Matches } from './match.ts';
import { encodingFor } from './optimize.ts';
import { greedy, lazy } from './parse.ts';

/** A refine task: from an encoding, at most `rounds` rounds. */
export interface Task { start: Encoding; rounds: number }
export interface TaskResult { encoding: Encoding; tokens: Tokens; bits: number; bytes: number; rounds: number }

/** Runs tasks on one data set; `tasks` may run them in parallel. */
export interface Runner {
  run(tasks: Task[]): Promise<TaskResult[]>;
}

/** The job a runner works on: the data, its protocol and profile. */
export interface Job { data: Uint8Array; protocol: Protocol; profile: Profile; header: boolean }

/** Runs tasks here, one after the other (the matches found once). */
export function localRunner(job: Job): Runner {
  let m: Matches | null = null;
  return {
    async run(tasks) {
      m ??= matchesFor(job.data, job.protocol, job.profile);
      return tasks.map(t => runTask(job, m!, t));
    },
  };
}

export function runTask(job: Job, m: Matches, t: Task): TaskResult {
  const r = refine(job.data, m, job.protocol, t.start, { ...job.profile, passes: t.rounds }, job.header, false);
  return { encoding: r.encoding, tokens: r.tokens, bits: r.bits, bytes: r.bytes, rounds: r.rounds };
}

const better = (a: TaskResult, b: TaskResult | null) => !b || a.bytes < b.bytes || (a.bytes === b.bytes && a.bits < b.bits);

/** The encodings one bit away from `e`, bucket by bucket. */
export function neighbours(e: Encoding): Encoding[] {
  const out: Encoding[] = [];
  const tables = [e.len, ...e.off];
  tables.forEach((t, ti) => t.forEach((b, i) => {
    for (const d of [-1, 1]) {
      if (b + d < 0 || b + d > 15) continue;
      const copy = tables.map(x => x.slice());
      copy[ti][i] = b + d;
      out.push({ len: copy[0], off: copy.slice(1) });
    }
  }));
  return out;
}

/**
 * Crunch with the thorough search. `runner` runs the tasks (in parallel threads, or here); `sweeps` bounds the
 * local search. The stream is written and checked here.
 */
export async function crunchSearch(d: Uint8Array, o: CrunchOptions, runner?: Runner, sweeps = 2): Promise<Crunched> {
  const t0 = performance.now();
  if (!d.length) throw new Error('There is nothing to crunch: the data is empty.');
  const p = protocol(o.protocol);
  const profile = { ...PROFILES[o.effort ?? 'max'], ...o.profile };
  const header = o.header !== false;
  const job: Job = { data: d, protocol: p, profile, header };
  const run = runner ?? localRunner(job);
  const m = matchesFor(d, p, profile);
  const seeds = [encodingFor(lazy(d, m, p), p.flags), encodingFor(greedy(d, m, p), p.flags), ...(o.seeds ?? [])];
  let best: TaskResult | null = null;
  let rounds = 0;
  for (const r of await run.run(seeds.map(start => ({ start, rounds: profile.passes })))) {
    rounds += r.rounds;
    if (better(r, best)) best = r;
  }
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const results = await run.run(neighbours(best!.encoding).map(start => ({ start, rounds: 3 })));
    let improved = false;
    for (const r of results) {
      rounds += r.rounds;
      if (better(r, best)) { best = r; improved = true; }
    }
    o.progress?.(sweep + 1, best!.bits);
    if (!improved) break;
  }
  const c = finish(d, { ...best!, rounds }, p, header, t0);
  return c;
}
