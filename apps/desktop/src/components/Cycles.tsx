/* Cycle counting (spec 10.1): the cycles of each instruction in the listing, and in the inspector the cycles of the
 * selected range or the block at the cursor along one path, with the branches the user marks as taken. */
import { useMemo } from 'react';
import { h4, instructionCycles, kickMnemonic, cycleText, type Addr, type AnalysisResult, type CyclePath, type CycleStep, type ListingLine, type RenderResult } from '@mimir/core';
import { cx } from '../lib/util';

export interface CycleView {
  /** the range being counted (selection, else the code block at the cursor) */
  path: CyclePath | null;
  taken: ReadonlySet<Addr>;
  onToggle: (pc: Addr) => void;
}

/** The listing's cycles column: `4`, `4+` (one more across a page), `2/3` for a branch (a click marks it taken), and
 *  inside the counted range the running total, dimmed where the path skips the line. */
export function CycleCell({ l, A, step, taken, onToggle }: { l: ListingLine; A: AnalysisResult; step: CycleStep | undefined; taken: ReadonlySet<Addr>; onToggle: (pc: Addr) => void }) {
  if (l.k !== 'ins') return <span className="cyc" />;
  const c = instructionCycles(A.mem, l.a);
  const skip = !!step && !step.counted;
  const sum = step && step.counted ? <span className="cy-sum" title={`${step.sum} cycles from the start of the range to the end of this line`}>{step.sum}</span> : null;
  if (c.taken != null) {
    const on = taken.has(l.a);
    const title = `Branch: ${c.base} cycles not taken, ${c.taken} taken${c.taken === 4 ? ' (the target is in another page)' : ''}. Click to mark it ${on ? 'not taken' : 'taken'}.`;
    return (
      <span className={cx('cyc', skip && 'skip')}>
        <button className={cx('cy-br', on && 'on')} title={title} aria-label={`Branch at $${h4(l.a)} ${on ? 'taken' : 'not taken'}`} aria-pressed={on}
          onMouseDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onToggle(l.a); }}>
          <span className={cx(!on && 'now')}>{c.base}</span>/<span className={cx(on && 'now')}>{c.taken}</span>
        </button>{sum}
      </span>
    );
  }
  const title = c.jam ? 'JAM: the CPU stops here' : `${c.base} cycles${c.page ? `, ${c.base + 1} when the index crosses a page` : ''}${l.mn === 'JSR' || l.mn === 'jsr' ? ', plus the subroutine' : ''}`;
  return <span className={cx('cyc', skip && 'skip')} title={title}><span className="cy-n">{cycleText(c)}</span>{sum}</span>;
}

/** The inspector's Cycles section for the counted range. */
export function CyclesSection({ path, R, onToggle, onNavigate }: { path: CyclePath; R: RenderResult; onToggle: (pc: Addr) => void; onNavigate: (a: Addr) => void }) {
  const ins = useMemo(() => { const m = new Map<Addr, string>(); for (const l of R.lines) if (l.k === 'ins' && !l.preview) m.set(l.a, `${kickMnemonic(l.mn)}${l.ext}${l.tok.length ? ' ' + l.tok.map(t => t.s).join('') : ''}`); return m; }, [R]);
  const span = `$${h4(path.start)}–$${h4(path.end - 1)}`;
  return (
    <section className="insp-sec cyc-sec" aria-label="Cycles">
      <div className="sec-head"><span>Cycles</span><span className="grow" /><span className="mono muted small">{span}</span></div>
      {!path.instructions ? <div className="empty small">No code to count in {span}.</div> : <>
        <div className="cyc-total"><b className="mono">{path.total}</b> cycles on this path{path.total !== path.straight && <span className="muted"> · {path.straight} with no branch taken</span>}</div>
        <div className="muted small">{path.instructions} instruction{path.instructions === 1 ? '' : 's'}{path.pageMax ? ` · up to +${path.pageMax} when indexes cross a page` : ''}{path.calls ? ` · ${path.calls} jsr: the subroutine${path.calls === 1 ? ' is' : 's are'} not counted` : ''}</div>
        {path.branches.length > 0 && <ul className="cyc-br-list">
          {path.branches.map(b => (
            <li key={b.pc} className={cx(!b.onPath && 'off')}>
              <label className="check"><input type="checkbox" checked={b.on} onChange={() => onToggle(b.pc)} aria-label={`Branch at $${h4(b.pc)} taken`} />
                <span className="mono"><button className="addr-link" onClick={e => { e.preventDefault(); onNavigate(b.pc); }}>${h4(b.pc)}</button> {ins.get(b.pc) ?? ''}</span></label>
              <span className="muted small">
                {b.notTaken}/{b.taken}{b.taken === 4 ? ' (page)' : ''} · {!b.onPath ? 'not on this path'
                  : b.back ? (b.pass != null ? `loop: one more pass takes ${b.pass}` : 'loops back out of the range')
                    : `${b.on ? 'not taken' : 'taken'}: ${b.other}${b.leaves ? ' (leaves the range)' : ''}`}
              </span>
            </li>
          ))}
        </ul>}
      </>}
      <p className="muted small">Select a range, or click a block header, to count it. A branch's cycles in the listing (or its box here) mark it as taken.</p>
    </section>
  );
}
