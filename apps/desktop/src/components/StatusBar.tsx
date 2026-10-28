import { ALL_PORTS, describePorts, h4, kindInfo, portName, portsOf, type Addr, type AnalysisResult, type Block } from '@mimir/core';
import { Icon } from '../lib/icons';
import { cx, fmtBytes } from '../lib/util';
import type { Sel } from '../lib/types';

interface StatusBarProps {
  A: AnalysisResult; fileCount: number; cursor: Addr | null; curLabel: string | null; blk: Block | null; sel: Sel | null;
  renderMs: number; busy: boolean; verify: { ok: boolean; kick: boolean | null } | null;
  /** cycle counting on: the cycles of the counted range on its path */
  cycles?: number | null;
}

export function StatusBar({ A, fileCount, cursor, curLabel, blk, sel, renderMs, busy, verify, cycles }: StatusBarProps) {
  // the memory configuration the instruction at the cursor runs with
  const port = cursor != null && A.mcfg ? A.mcfg.port[A.codeOwner[cursor] >= 0 ? A.codeOwner[cursor] : cursor] : 0;
  return (
    <footer className="statusbar">
      <span className="sb-item"><Icon name="chip" size={13} />6510 · PAL</span>
      <span className="sb-item hide-narrow">{fileCount} file{fileCount === 1 ? '' : 's'} · {fmtBytes(A.stats.total)}</span>
      {cursor != null && <span className="sb-item mono">${h4(cursor)}{curLabel ? ` · ${curLabel}` : ''}{blk ? ` · ${kindInfo(blk.type).label}` : ''}</span>}
      {port > 0 && <span className="sb-item mono hide-narrow" title={`Memory configuration here: ${describePorts(port)}`}>$01 {port === ALL_PORTS ? '?' : portsOf(port).map(portName).join('/')}</span>}
      {sel && sel.multi && <span className="sb-item mono hide-narrow">sel ${h4(sel.start)}–${h4(sel.end - 1)} ({sel.end - sel.start} B)</span>}
      {cycles != null && <span className="sb-item mono" title="Cycles of the selection (or the code block at the cursor) on the path in the Cycles section">{cycles} cycles</span>}
      <span className="grow" />
      <span className="sb-item hide-narrow">{busy ? 'analysing…' : `analysis ${A.stats.ms.toFixed(1)} ms · render ${renderMs.toFixed(1)} ms (worker)`}</span>
      <span className={cx('sb-item', verify && (verify.ok ? 'ok' : 'bad'))}>
        {verify ? (verify.ok ? `✓ round-trip verified${verify.kick ? ' with KickAss.jar' : ''}` : '✗ round-trip failed') : 'round-trip not verified'}
      </span>
      <span className="sb-item hide-narrow">Kick Assembler 5.x</span>
    </footer>
  );
}
