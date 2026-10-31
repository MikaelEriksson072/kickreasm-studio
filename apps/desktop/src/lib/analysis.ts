/* Renderer side of the analysis worker: Comlink proxy + a hook that re-analyses (debounced 30 ms)
 * whenever the project changes, and only re-renders when just labels or comments changed. */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import type { AnalysisResult, Project, RenderOptions, RenderResult, VerifyResult } from '@mimir/core';
import type { AnalysisApi } from '../workers/analysis.worker';

let remote: Comlink.Remote<AnalysisApi> | null = null;

export function analysisWorker(): Comlink.Remote<AnalysisApi> {
  if (!remote) {
    const worker = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), { type: 'module', name: 'mimir-analysis' });
    remote = Comlink.wrap<AnalysisApi>(worker);
  }
  return remote;
}

let keyCounter = 0;

export interface Analysis {
  A: AnalysisResult;
  R: RenderResult;
  /** identifies the analysis inputs (files, overrides, entries, program start, bank zones, settings, the cartridge) */
  aKey: number;
  renderMs: number;
  /** the project this result was computed for (work that awaits compares it with the latest edit) */
  project: Project;
}

export function useAnalysis(project: Project, opts: RenderOptions = {}): { analysis: Analysis | null; error: string | null; busy: boolean } {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Immer keeps unchanged branches referentially equal, so identity tells what changed
  const last = useRef<{ files: unknown; overrides: unknown; entries: unknown; entryPoint: unknown; bankZones: unknown; settings: unknown; cart: unknown; key: number } | null>(null);
  const aKey = useMemo(() => {
    const l = last.current;
    if (!l || l.files !== project.files || l.overrides !== project.overrides || l.entries !== project.entries || l.entryPoint !== project.entryPoint || l.bankZones !== project.bankZones || l.settings !== project.settings || l.cart !== project.cart) {
      last.current = { files: project.files, overrides: project.overrides, entries: project.entries, entryPoint: project.entryPoint, bankZones: project.bankZones, settings: project.settings, cart: project.cart, key: ++keyCounter };
    }
    return last.current!.key;
  }, [project.files, project.overrides, project.entries, project.entryPoint, project.bankZones, project.settings, project.cart]);

  const seq = useRef(0);
  const hasResult = analysis != null;
  useEffect(() => {
    const mine = ++seq.current;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const res = await analysisWorker().run(project, aKey, opts);
        if (mine !== seq.current) return;
        setAnalysis(prev => {
          const A = res.A ?? (prev && prev.aKey === aKey ? prev.A : null);
          return A ? { A, R: res.R, aKey, renderMs: res.renderMs, project } : prev;
        });
        setError(null);
      } catch (e) {
        if (mine === seq.current) setError(String((e as Error)?.message ?? e));
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, hasResult ? 30 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, aKey, opts.dataAsCode]);

  return { analysis, error, busy };
}

export const verifyInWorker = (project: Project, aKey: number): Promise<VerifyResult & { ms: number }> => analysisWorker().verify(project, aKey);
