/* =====================================================================
 * Analysis engine: a deterministic pipeline over at most 64 KB.
 * The whole chain re-runs after every override (spec section 8).
 * ===================================================================== */
import type { AnalysisResult, GfxCandidate, MemConfigInfo, MusicInfo, ProjectInput, VicEvidence } from '../types';
import { DEFAULT_SETTINGS } from '../model';
import { $4, now } from '../util/hex';
import { createContext, type Ctx, type Deep } from './context';
import { applyOverrides, findBasicStubs, loadMemory } from './memory';
import { releaseFlags, seedEntries, settle, sweepForcedCode, trace } from './trace';
import { evidence } from './evidence';
import { resolveTables, warnUnresolvedJumps } from './pointers';
import { detectMusic } from './music';
import { memConfig } from './banks';
import { vicEvidence } from './vic';
import { classify, type Classification } from './classify';
import { makeLabels } from './labels';
import { codeIslands, diagnostics, ioLabelNotice, statistics, type CodeIsland } from './diagnostics';
import { findLoaders } from './loaders';
import { rasterIrqs } from './raster';
import { deepLog, learn, problemCount } from './deep';
import { findDelays } from './delay';

export { findBlock } from './classify';

/** At most this many rounds of a deep analysis (5.17). */
const DEEP_ROUNDS = 6;

export function analyze(project: ProjectInput): AnalysisResult {
  if (!project.settings?.deepAnalysis) return analyzeOnce(project, null)[0];
  // 5.17: the normal analysis tells how many problems the deep one starts from
  const t0 = now();
  const [normal] = analyzeOnce({ ...project, settings: { ...DEFAULT_SETTINGS, ...project.settings, deepAnalysis: false } }, null);
  const before = problemCount(normal.log);
  const deep: Deep = { port: null, main: 0, written: null, noReturn: new Set() };
  let A: AnalysisResult, ctx: Ctx, rounds = 0;
  do [A, ctx] = analyzeOnce(project, deep);
  while (++rounds < DEEP_ROUNDS && learn(A, ctx, deep));
  deepLog(A, ctx, before, rounds);
  const report = A.deep!;
  report.ms = now() - t0;
  if (report.after <= before) return A;
  normal.log.push({ lvl: 'info', msg: `Deep analysis: no reading with fewer problems than the normal analysis (${before}) was found, so this is the normal one`, addr: null, cat: 'deep' });
  return { ...normal, S: A.S, deep: { ...report, after: before } };
}

function analyzeOnce(project: ProjectInput, deepIn: Deep | null): [AnalysisResult, Ctx] {
  const t0 = now();
  const ctx = createContext(project, deepIn);

  loadMemory(ctx); // 5.1
  applyOverrides(ctx); // 5.2
  findBasicStubs(ctx); // 5.3
  seedEntries(ctx); // 5.4

  // 5.4-5.6: trace, gather evidence and resolve tables until no new entry points appear. A deep analysis traces its
  // guesses on trial (settle) and follows both sides of a branch reached some other way after all (releaseFlags)
  const traceAll = () => {
    for (let iter = 0; iter < 8; iter++) {
      trace(ctx); settle(ctx); evidence(ctx); findDelays(ctx);
      if (ctx.deep && releaseFlags(ctx)) { iter--; continue; }
      resolveTables(ctx);
      if (!ctx.queue.length && !ctx.pending.length) break;
    }
    trace(ctx); settle(ctx); evidence(ctx); findDelays(ctx);
    while (ctx.deep && releaseFlags(ctx)) { trace(ctx); evidence(ctx); }
    warnUnresolvedJumps(ctx);
  };
  traceAll();

  sweepForcedCode(ctx); // 5.7
  evidence(ctx);

  // 5.8-5.11; then the code islands the classification leaves (5.13) are traced, classifying again (with the same
  // configuration, music and graphics) to find the islands that leaves, up to 4 rounds, and 5.8-5.11 run once more.
  // A classification that is done again takes back its messages
  let mcfg: MemConfigInfo | null = null, music: MusicInfo[] = [], vic!: VicEvidence, gfx: GfxCandidate[] = [], cls!: Classification;
  const stage = (full: boolean) => {
    if (full) {
      mcfg = ctx.S.bankTracking ? memConfig(ctx) : null; // 5.8b
      // a player found before stays one: the code islands lead to may run into it
      const found = detectMusic(ctx); // 5.8
      music = [...found, ...music.filter(m => !m.user && !found.some(f => f.start < m.end && m.start < f.end))].sort((x, y) => x.start - y.start);
      ({ vic, gfx } = vicEvidence(ctx, mcfg)); // 5.9
    }
    cls = classify(ctx, music, gfx, mcfg); // 5.10, 5.11
  };
  const takeBack = (n: number) => {
    ctx.log.length = n;
    ctx.logged.clear();
    for (const l of ctx.log) ctx.logged.add(l.lvl + l.msg);
  };
  // a deep analysis tells about an island once tracing it on trial kept it, and leaves the ones it did not keep
  const island = (c: CodeIsland) => ctx.L('info', `Unreached code at ${$4(c.at)}: ${c.n} instructions ending in ${c.last}, so it is decoded as code. Mark it as data (D) if it is not.`, c.at, 'code');
  const deep = ctx.deep;
  let logAt = ctx.log.length, rounds = 0;
  stage(true);
  for (; ctx.S.codeIslands && rounds < 4; rounds++) {
    const islands = codeIslands(ctx, cls.blocks, cls.music, deep ? a => ctx.rejected.has(a) : undefined);
    if (!islands.length) break;
    takeBack(logAt);
    for (const c of islands) { ctx.enqueue(c.at, 'guess'); if (!deep) island(c); }
    traceAll();
    if (deep) for (const c of islands) if (ctx.insLen[c.at]) island(c);
    logAt = ctx.log.length;
    stage(false);
  }
  if (rounds) { takeBack(logAt); stage(true); }
  const { labels, zp } = makeLabels(ctx, cls, vic); // 5.12
  diagnostics(ctx, cls.blocks); // 5.13
  ioLabelNotice(ctx, labels); // 5.13: I/O named as RAM because bank tracking is off
  const loaders = findLoaders(ctx, cls.blocks); // 5.15
  const raster = rasterIrqs(ctx); // 5.16
  const stats = statistics(ctx, cls.tm, cls.blocks, labels, t0); // 5.14

  const { S, files, mem, owner, insLen, codeOwner, skip, xrefs, entryKind, entry, basics, lohiTabs, ijumps, inlineCalls, log } = ctx;
  const { hints, smc, textPtrs } = ctx.ev;
  return [{
    S, files, mem, owner, insLen, codeOwner, skip, xrefs, entryKind, entry, basics, music: cls.music, vic, gfx: cls.gfxBlocks,
    tm: cls.tm, blocks: cls.blocks, labels, zp, hints, smc, offsetOf: cls.offsetOf, lohiTabs, ijumps, inlineCalls, log, stats, textPtrs, mcfg, loaders, raster,
    delays: [...ctx.delays.values()].sort((x, y) => x.branch - y.branch), deep: null,
  }, ctx];
}
