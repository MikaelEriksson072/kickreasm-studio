/* Merge range: a start, an end (included) and a block type; every block inside the range becomes one block of that
 * type. With the cursor in a block the start and the type come from that block, so only the end is needed. Nothing
 * changes until the summary of what is replaced has been confirmed. */
import { useMemo, useState, type KeyboardEvent } from 'react';
import { findBlock, h4, kindInfo, markIdOf, MARK_AS, mergeRange, type Addr, type AnalysisResult, type Block, type Override, type RenderResult } from '@kickreasm/core';
import { parseGoto } from '../lib/goto';
import { Modal } from './Modal';

interface MergeRangeProps {
  A: AnalysisResult; R: RenderResult; cursor: Addr | null;
  /** a selected range fills in start and end */
  sel: { start: Addr; end: Addr; multi: boolean } | null;
  onMerge: (override: Override, label: string, replaced: number) => void;
  onClose: () => void;
}

const SHOWN = 8;

export function MergeRangeModal({ A, R, cursor, sel, onMerge, onClose }: MergeRangeProps) {
  const range = sel?.multi ? sel : null;
  const blk = cursor != null ? findBlock(A.blocks, cursor) : null;
  const [startV, setStartV] = useState(range ? `$${h4(range.start)}` : '');
  const [endV, setEndV] = useState(range ? `$${h4(range.end - 1)}` : '');
  const start0 = range ? findBlock(A.blocks, range.start) : blk;
  const [id, setId] = useState(start0 ? markIdOf(start0) : 'bytes');
  const [stage, setStage] = useState<'edit' | 'confirm'>('edit');

  const labelAt = (name: string) => { for (const [a, l] of R.labels) if (l.name === name) return a; return undefined; };
  const one = (v: string): Addr | null => { const t = parseGoto(v, labelAt); return 'addr' in t ? t.addr : null; };
  const plan = useMemo(() => {
    const s = startV.trim() ? one(startV) : blk ? blk.start : null;
    if (s == null) return { error: startV.trim() ? 'Start: enter one hex address like $0a00, or a label.' : 'Enter the start: the cursor is not in a block.' };
    if (!endV.trim()) return { error: 'Enter the end address (it is included in the range).' };
    const e = one(endV);
    if (e == null) return { error: 'End: enter one hex address like $0aff, or a label.' };
    if (e < s) return { error: `The end $${h4(e)} comes before the start $${h4(s)}.` };
    // the block the range starts in gives its settings (number format, table kind, music init/play) when the type matches
    const r = mergeRange(A, s, e + 1, id, findBlock(A.blocks, s));
    return 'error' in r ? { error: `${r.error[0].toUpperCase()}${r.error.slice(1)}.` } : r;
  }, [startV, endV, id, A, R]); // eslint-disable-line react-hooks/exhaustive-deps

  const typeLabel = MARK_AS.find(m => m.id === id)?.label ?? id;
  const name = (b: Block) => R.labels.get(b.start)?.name;
  const row = (b: Block) => <li key={b.id}><span className="mono">${h4(b.start)}–${h4(b.end - 1)}</span> {kindInfo(b.type).label}{name(b) && <span className="mono muted"> {name(b)}</span>}</li>;
  const ok = !('error' in plan);
  const span = ok ? `$${h4(plan.override.start)}–$${h4(plan.override.end - 1)}` : '';
  const n = ok ? plan.replaced.length : 0;
  const cuts = ok && plan.cut.map(b => {
    const o = plan.override, before = b.start < o.start, after = b.end > o.end;
    const kept = [before && `$${h4(b.start)}–$${h4(o.start - 1)}`, after && `$${h4(o.end)}–$${h4(b.end - 1)}`].filter(Boolean).join(' and ');
    return <li key={`cut-${b.id}`}>{kindInfo(b.type).label}{name(b) ? ` ${name(b)}` : ''} <span className="mono">${h4(b.start)}–${h4(b.end - 1)}</span> is cut: <span className="mono">{kept}</span> keeps its type</li>;
  });
  const codeNote = ok && plan.into === 'code' && <p className="muted small">Code stays split per routine: the range is disassembled from its start, and the listing shows one block per routine.</p>;

  if (stage === 'confirm' && ok) return (
    <Modal title="Merge range into one block" onClose={onClose}>
      <div className="modal-body merge-range">
        <p><b>Merge {span} into one {typeLabel} block?</b></p>
        <p className="small">{n ? `This replaces ${n} block${n === 1 ? '' : 's'}:` : 'No whole block lies inside the range.'}</p>
        {n > 0 && <ul className="merge-list">{plan.replaced.map(row)}</ul>}
        {cuts && cuts.length > 0 && <ul className="merge-list cut">{cuts}</ul>}
        {codeNote}
        <p className="muted small">You can undo it with Ctrl+Z.</p>
      </div>
      <div className="modal-foot"><span className="grow" /><button className="btn" onClick={() => setStage('edit')}>Back</button>
        <button className="btn primary" autoFocus onClick={() => onMerge(plan.override, typeLabel, n)}>Merge {n} block{n === 1 ? '' : 's'}</button></div>
    </Modal>
  );

  const next = () => { if (ok) setStage('confirm'); };
  const enter = (e: KeyboardEvent) => { if (e.key === 'Enter') next(); };
  return (
    <Modal title="Merge range into one block" onClose={onClose}>
      <div className="modal-body merge-range">
        <div className="grid2">
          <label className="field"><span>Start</span><input id="merge-start" className="mono" value={startV} spellCheck={false} onChange={e => setStartV(e.target.value)} onKeyDown={enter}
            placeholder={blk ? `$${h4(blk.start)} (this block)` : '$0a00 or a label'} autoFocus={!blk} /></label>
          <label className="field"><span>End (included)</span><input id="merge-end" className="mono" value={endV} spellCheck={false} onChange={e => setEndV(e.target.value)} onKeyDown={enter}
            placeholder="$0aff or a label" autoFocus={!!blk} /></label>
        </div>
        <label className="field"><span>Block type</span>
          <select id="merge-type" value={id} onChange={e => setId(e.target.value)}>{MARK_AS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
        {blk && !startV.trim() && <p className="muted small">The cursor is in the {kindInfo(blk.type).label} block at ${h4(blk.start)}{name(blk) ? ` (${name(blk)})` : ''}: the range starts there and the type is taken from it.</p>}
        {ok ? <div className="merge-sum">
          <p className="small"><b>{n} block{n === 1 ? '' : 's'}</b> become{n === 1 ? 's' : ''} one {typeLabel} block {span} ({plan.override.end - plan.override.start} bytes).</p>
          {n > 0 && <ul className="merge-list">{plan.replaced.slice(0, SHOWN).map(row)}{n > SHOWN && <li className="muted">and {n - SHOWN} more</li>}</ul>}
          {cuts && cuts.length > 0 && <ul className="merge-list cut">{cuts}</ul>}
          {codeNote}
        </div> : <div className="err-text small">{plan.error}</div>}
      </div>
      <div className="modal-foot"><span className="grow" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!ok} onClick={next}>Merge…</button></div>
    </Modal>
  );
}
