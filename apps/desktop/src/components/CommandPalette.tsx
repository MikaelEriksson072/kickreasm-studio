/* Command palette (Ctrl+Shift+P / F1) and the "Go to address, label or range" dialog (G / Ctrl+G). */
import { useEffect, useState } from 'react';
import type { Addr, RenderResult } from '@kickreasm/core';
import { cx } from '../lib/util';
import { parseGoto } from '../lib/goto';
import type { Command } from '../lib/types';
import { Modal } from './Modal';

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState(''); const [i, setI] = useState(0);
  const list = commands.filter(c => c.label.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => setI(0), [q]);
  return (
    <div className="modal-back top" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={e => e.stopPropagation()}>
        <label htmlFor="pal-q" className="sr-only">Command</label>
        <input id="pal-q" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Type a command"
          onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setI(x => Math.min(list.length - 1, x + 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setI(x => Math.max(0, x - 1)); } if (e.key === 'Enter' && list[i]) { onClose(); list[i].run(); } if (e.key === 'Escape') onClose(); }} />
        <div className="pal-list">{list.map((c, k) => <button key={c.id} className={cx('pal-row', k === i && 'on')} onMouseEnter={() => setI(k)} onClick={() => { onClose(); c.run(); }}><span>{c.label}</span>{c.key && <kbd>{c.key}</kbd>}</button>)}</div>
      </div>
    </div>
  );
}

export function GotoModal({ R, onGo, onSelect, onClose }: { R: RenderResult; onGo: (a: Addr) => void; onSelect: (start: Addr, end: Addr) => void; onClose: () => void }) {
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  const go = () => {
    const t = parseGoto(v, name => { for (const [a, l] of R.labels) if (l.name === name) return a; return undefined; });
    if ('error' in t) setErr(t.error);
    else if ('addr' in t) onGo(t.addr);
    else onSelect(t.start, t.end);
  };
  return (
    <Modal title="Go to address, label or range" onClose={onClose}>
      <div className="modal-body">
        <label className="field"><span>Address (hex), label or range</span><input id="goto-input" autoFocus className="mono" value={v} onChange={e => { setV(e.target.value); setErr(''); }} onKeyDown={e => { if (e.key === 'Enter') go(); }} placeholder="$1000, irq_08b7 or $2000-$27ff" list="goto-labels" /></label>
        <datalist id="goto-labels">{[...R.labels.values()].slice(0, 400).map(l => <option key={l.name} value={l.name} />)}</datalist>
        {err ? <div className="err-text small">{err}</div> : <div className="muted small">A range (end included) is selected, ready for Mark as. Blocks inside it are merged into the new block.</div>}
      </div>
      <div className="modal-foot"><span className="grow" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go}>Go</button></div>
    </Modal>
  );
}
