/* Analysis worker (spec 4.3): runs @mimir/core off the UI thread. analyze() only re-runs when
 * the files, overrides, entries, program start, bank zones or settings changed (the caller bumps `aKey`); labels and comments
 * only re-render, which keeps renames instant. */
import * as Comlink from 'comlink';
import { analyze, render, verify, type AnalysisResult, type Project, type RenderOptions, type RenderResult, type VerifyResult } from '@mimir/core';

let current: { aKey: number; A: AnalysisResult } | null = null;

export interface RunResult {
  aKey: number;
  /** only present when the analysis was recomputed (saves a structured clone of 64 KB tables) */
  A: AnalysisResult | null;
  R: RenderResult;
  renderMs: number;
}

const api = {
  /** `opts` only changes the listing (data as code); files and verification never see it */
  run(project: Project, aKey: number, opts: RenderOptions = {}): RunResult {
    let fresh = false;
    if (!current || current.aKey !== aKey) { current = { aKey, A: analyze(project) }; fresh = true; }
    const t0 = performance.now();
    const R = render(current.A, project, opts);
    return { aKey, A: fresh ? current.A : null, R, renderMs: performance.now() - t0 };
  },

  /** Round trip with the built-in Kick-subset assembler (render is cheap, so it is redone here). */
  verify(project: Project, aKey: number): VerifyResult & { ms: number } {
    const t0 = performance.now();
    if (!current || current.aKey !== aKey) current = { aKey, A: analyze(project) };
    return { ...verify(current.A, render(current.A, project)), ms: performance.now() - t0 };
  },
};

export type AnalysisApi = typeof api;

Comlink.expose(api);
