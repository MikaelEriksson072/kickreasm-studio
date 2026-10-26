/* =====================================================================
 * Analysis engine: a deterministic pipeline over at most 64 KB.
 * The whole chain re-runs after every override (spec section 8).
 * ===================================================================== */
import type { AnalysisResult, GfxCandidate, MemConfigInfo, MusicInfo, ProjectInput, VicEvidence } from '../types';
import { $4, now } from '../util/hex';
import { createContext } from './context';
import { applyOverrides, findBasicStubs, loadMemory } from './memory';
import { seedEntries, sweepForcedCode, trace } from './trace';
import { evidence } from './evidence';
import { resolveTables, warnUnresolvedJumps } from './pointers';
import { detectMusic } from './music';
import { memConfig } from './banks';
import { vicEvidence } from './vic';
import { classify, type Classification } from './classify';
import { makeLabels } from './labels';
import { codeIslands, diagnostics, ioLabelNotice, statistics } from './diagnostics';
import { findLoaders } from './loaders';
import { rasterIrqs } from './raster';

export { findBlock } from './classify';

export function analyze(project: ProjectInput): AnalysisResult {
  const t0 = now();
  const ctx = createContext(project);

  loadMemory(ctx); // 5.1
  applyOverrides(ctx); // 5.2
  findBasicStubs(ctx); // 5.3
  seedEntries(ctx); // 5.4

  // 5.4-5.6: trace, gather evidence and resolve tables until no new entry points appear
  const traceAll = () => {
    for (let iter = 0; iter < 8; iter++) {
      trace(ctx); evidence(ctx);
      resolveTables(ctx);
      if (!ctx.queue.length) break;
    }
    trace(ctx); evidence(ctx);
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
  let logAt = ctx.log.length, rounds = 0;
  stage(true);
  for (; ctx.S.codeIslands && rounds < 4; rounds++) {
    const islands = codeIslands(ctx, cls.blocks, cls.music);
    if (!islands.length) break;
    takeBack(logAt);
    for (const c of islands) {
      ctx.enqueue(c.at, 'guess');
      ctx.L('info', `Unreached code at ${$4(c.at)}: ${c.n} instructions ending in ${c.last}, so it is decoded as code. Mark it as data (D) if it is not.`, c.at, 'code');
    }
    traceAll();
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
  return {
    S, files, mem, owner, insLen, codeOwner, skip, xrefs, entryKind, entry, basics, music: cls.music, vic, gfx: cls.gfxBlocks,
    tm: cls.tm, blocks: cls.blocks, labels, zp, hints, smc, offsetOf: cls.offsetOf, lohiTabs, ijumps, inlineCalls, log, stats, textPtrs, mcfg, loaders, raster,
  };
}
