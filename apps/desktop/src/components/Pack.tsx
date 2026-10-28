/* Pack (spec 13.8): Exomizer packs the PRG that Build & Run builds, whole or the blocks you choose, as a
 * self-extracting program (sfx) or as crunched data for your own decruncher (mem). The view sits in the sidebar, so the
 * listing beside it shows the blocks you choose. Its settings are kept in the project; Pack builds, verifies and packs. */
import { useEffect, useState, type KeyboardEvent } from 'react';
import { editRanges, extraProblem, h2, h4, kindInfo, mergeRanges, packProblem, rangeCover, type Addr, type AnalysisResult, type PackPrefs, type Project, type RenderResult } from '@kickreasm/core';
import type { PackResponse } from '../../shared/ipc';
import { Icon } from '../lib/icons';
import { SideSection } from './SideSection';
import { packCommand, packWarning } from '../lib/pack';
import { cx, fmtBytes, groupOfKind } from '../lib/util';
import type { Sel } from '../lib/types';

/** the last pack, with the fingerprint of what it packed (prefs and build) */
export interface PackResult extends PackResponse { key: string }

export interface PackViewProps {
  A: AnalysisResult; R: RenderResult; project: Project; cursor: Addr | null; sel: Sel | null;
  prefs: PackPrefs;
  /** Exomizer from the toolchain settings ('' = none) */
  exomizer: string;
  desktop: boolean;
  /** what the app is busy with (Verifying, Packing…), or null */
  busy: string | null;
  result: PackResult | null;
  /** the fingerprint of what would be packed now: a result with another one is out of date */
  current: string;
  onChange: (p: PackPrefs, label: string) => void;
  onPack: () => void; onRun: () => void; onSave: () => void; onLog: () => void; onSettings: () => void;
  onNavigate: (a: Addr) => void;
}

const parseHex = (s: string, max = 0xffff): number | null | undefined => {
  const t = s.trim().replace(/^(\$|0x)/i, '');
  if (!t) return null;
  if (!/^[0-9a-f]{1,4}$/i.test(t)) return undefined;
  const v = parseInt(t, 16);
  return v <= max ? v : undefined;
};

/** A hex field that commits on Enter or when it loses focus; empty is null. */
function HexField({ id, label, value, max = 0xffff, placeholder, onCommit, help }: { id: string; label: string; value: number | null; max?: number; placeholder?: string; onCommit: (v: number | null) => void; help?: string }) {
  const show = (v: number | null) => (v == null ? '' : `$${max > 0xff ? h4(v) : h2(v)}`);
  const [text, setText] = useState(show(value));
  useEffect(() => setText(show(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const v = parseHex(text, max);
  const commit = () => { if (v !== undefined && v !== value) onCommit(v); };
  return (
    <div className="field"><label htmlFor={id}>{label}</label>
      <input id={id} className={cx('mono', v === undefined && 'bad')} value={text} placeholder={placeholder} spellCheck={false}
        onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
      {v === undefined ? <small className="err-text">A hex number up to ${max > 0xff ? h4(max) : h2(max)}.</small> : help && <small className="muted">{help}</small>}
    </div>
  );
}

/** A text field that commits on Enter or when it loses focus (one undo step, not one per key). */
function TextField({ id, label, value, placeholder, error, help, onCommit }: { id: string; label: string; value: string; placeholder?: string; error?: string | null; help?: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => { if (text !== value) onCommit(text); };
  const enter = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
  return (
    <div className="field"><label htmlFor={id}>{label}</label>
      <input id={id} className="mono" value={text} placeholder={placeholder} spellCheck={false} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={enter} />
      {error ? <small className="err-text">{error}</small> : help && <small className="muted">{help}</small>}
    </div>
  );
}

export function PackView(p: PackViewProps) {
  const { A, R, project, cursor, sel, prefs, exomizer, desktop, busy, result, current } = p;
  const [q, setQ] = useState('');
  const set = (patch: Partial<PackPrefs>, label: string) => p.onChange({ ...prefs, ...patch }, label);
  const exe = exomizer ? exomizer.split(/[\\/]/).pop()! : 'exomizer';
  const cmd = packCommand(prefs, project.files, R.fileNames, exe);
  const problem = packProblem(prefs) ?? (prefs.ranges && !cmd.parts.length ? 'None of the chosen ranges holds loaded bytes.' : null);
  const warning = packWarning(prefs, A);
  const ranges = prefs.ranges ?? [];
  const toggle = (start: Addr, end: Addr, on: boolean, what: string) => set({ ranges: editRanges(ranges, start, end, on) }, `${on ? 'Pack' : 'Do not pack'} ${what}`);
  const selRange = sel && sel.multi && sel.end > sel.start ? sel : null;
  const blk = cursor != null ? A.blocks.find(b => cursor >= b.start && cursor < b.end) : undefined;
  const ql = q.trim().toLowerCase().replace(/^\$/, '');
  const list = prefs.ranges ? A.blocks.filter(b => { const l = R.labels.get(b.start); return !ql || h4(b.start).includes(ql) || kindInfo(b.type).label.toLowerCase().includes(ql) || !!l?.name.toLowerCase().includes(ql); }) : [];
  const fresh = !!result && result.key === current;
  const ready = desktop && !!exomizer && !problem && !busy;

  return (
    <div className="side-inner pack-view">
      <div className="side-title">Pack <span className="muted">Exomizer</span></div>
      {!desktop && <p className="muted small pack-note">Packing runs Exomizer, so it needs the desktop app.</p>}
      {desktop && !exomizer && <div className="pack-note"><p className="muted small">No Exomizer is set. The installed app comes with Exomizer 3.1.1; or set your own.</p><button className="btn small" onClick={p.onSettings}>Settings…</button></div>}

      <SideSection id="pack-what" title="What to pack">
        <div className="seg wide pack-seg" role="tablist" aria-label="What to pack">
          <button role="tab" aria-selected={!prefs.ranges} className={cx(!prefs.ranges && 'on')} onClick={() => prefs.ranges && set({ ranges: null }, 'Pack the whole build')}>Whole build</button>
          <button role="tab" aria-selected={!!prefs.ranges} className={cx(prefs.ranges && 'on')} onClick={() => !prefs.ranges && set({ ranges: selRange ? [{ start: selRange.start, end: selRange.end }] : [] }, 'Pack chosen blocks')}>Chosen blocks</button>
        </div>
        {!prefs.ranges ? (
          <div className="pack-files">
            {project.files.map((f, i) => <div key={f.id || i} className="mono small"><Icon name="doc" size={12} /> {R.fileNames[i]}.prg <span className="muted">${h4(f.load)}–${h4(f.load + f.bytes.length - 1)} · {fmtBytes(f.bytes.length)}</span></div>)}
            <p className="muted small">The PRG{project.files.length > 1 ? 's' : ''} Build &amp; Run builds{project.files.length > 1 ? ', packed together into one file' : ''}.</p>
          </div>
        ) : <>
          <div className="pack-sum small">{ranges.length ? <><b>{fmtBytes(cmd.size)}</b> <span className="muted">from ${h4(cmd.parts[0]?.start ?? ranges[0].start)} in {ranges.length} range{ranges.length > 1 ? 's' : ''}</span></> : <span className="muted">Nothing chosen yet: tick blocks below, or select a range in the listing.</span>}</div>
          {ranges.length > 0 && <div className="pack-ranges" role="list" aria-label="Ranges to pack">
            {mergeRanges(ranges).map(r => (
              <span key={r.start} role="listitem" className="pack-range mono">
                <button className="pack-range-go" title="Show in the listing" onClick={() => p.onNavigate(r.start)}>${h4(r.start)}–${h4(r.end - 1)}</button>
                <button className="icon-btn" aria-label={`Do not pack $${h4(r.start)}-$${h4(r.end - 1)}`} title="Do not pack this range" onClick={() => toggle(r.start, r.end, false, `$${h4(r.start)}-$${h4(r.end - 1)}`)}><Icon name="x" size={11} /></button>
              </span>))}
          </div>}
          <div className="bm-actions pack-add">
            {selRange && rangeCover(ranges, selRange.start, selRange.end) < selRange.end - selRange.start && <button className="btn small" onClick={() => toggle(selRange.start, selRange.end, true, `$${h4(selRange.start)}-$${h4(selRange.end - 1)}`)}><Icon name="plus" size={12} />Selection ${h4(selRange.start)}–${h4(selRange.end - 1)}</button>}
            {!selRange && blk && rangeCover(ranges, blk.start, blk.end) < blk.end - blk.start && <button className="btn small" onClick={() => toggle(blk.start, blk.end, true, `$${h4(blk.start)}-$${h4(blk.end - 1)}`)}><Icon name="plus" size={12} />Block at the cursor</button>}
            {ranges.length > 0 && <button className="btn small ghost" onClick={() => set({ ranges: [] }, 'Pack no blocks')}>Clear</button>}
          </div>
          <div className="side-search"><Icon name="search" size={14} /><label htmlFor="pack-q" className="sr-only">Filter blocks</label><input id="pack-q" value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by name, type or address" /></div>
          <div className="pack-blocks" role="list" aria-label="Blocks">
            {list.map(b => {
              const cover = rangeCover(ranges, b.start, b.end), len = b.end - b.start, all = cover === len, l = R.labels.get(b.start);
              const what = `$${h4(b.start)}-$${h4(b.end - 1)}`;
              return (
                <div key={b.id} role="listitem" className={cx('pack-blk', cursor != null && cursor >= b.start && cursor < b.end && 'on')}>
                  <input type="checkbox" aria-label={`Pack ${what}`} checked={all} ref={el => { if (el) el.indeterminate = cover > 0 && !all; }} onChange={() => toggle(b.start, b.end, !all, what)} />
                  <button className="pack-blk-main" title="Show in the listing" onClick={() => p.onNavigate(b.start)}>
                    <i style={{ background: `var(--g-${groupOfKind(b.type)})` }} />
                    <span className="blk-name">{l ? l.name : kindInfo(b.type).label}</span>
                    <span className="muted mono small">${h4(b.start)} · {fmtBytes(len)}</span>
                  </button>
                </div>);
            })}
          </div>
        </>}
      </SideSection>

      <SideSection id="pack-file" title="Packed file">
        <div className="seg wide pack-seg" role="tablist" aria-label="Kind of packed file">
          <button role="tab" aria-selected={prefs.mode === 'sfx'} className={cx(prefs.mode === 'sfx' && 'on')} title="A program that decrunches itself and starts (exomizer sfx)" onClick={() => set({ mode: 'sfx' }, 'Pack as a self-extracting program')}>Self-extracting</button>
          <button role="tab" aria-selected={prefs.mode === 'mem'} className={cx(prefs.mode === 'mem' && 'on')} title="Crunched data that your own code decrunches (exomizer mem)" onClick={() => set({ mode: 'mem' }, 'Pack as crunched data')}>Crunched data</button>
        </div>
        {prefs.mode === 'sfx' ? <>
          <div className="field"><label htmlFor="pack-start">Start after decrunching</label>
            <select id="pack-start" value={prefs.start} onChange={e => set({ start: e.target.value as PackPrefs['start'], ...(e.target.value === 'jmp' && prefs.jmp == null ? { jmp: A.entry } : {}) }, 'Pack: start')}>
              <option value="sys">The SYS in the BASIC line</option>
              <option value="jmp">Jump to an address</option>
              <option value="basic">RUN (a BASIC program)</option>
            </select></div>
          {prefs.start === 'jmp' && <HexField id="pack-jmp" label="Jump to" value={prefs.jmp} placeholder="$0810" onCommit={v => set({ jmp: v }, 'Pack: jump address')}
            help={A.entry != null && A.entry !== prefs.jmp ? `The program start is $${h4(A.entry)}.` : undefined} />}
          {warning && <p className="warn-text small">{warning}</p>}
          <div className="field"><label htmlFor="pack-effect">Effect while decrunching</label>
            <select id="pack-effect" value={prefs.effect} onChange={e => set({ effect: e.target.value as PackPrefs['effect'] }, 'Pack: effect')}>
              <option value="default">Exomizer's own</option>
              <option value="none">None (-n)</option>
              <option value="x1">Border flash 1 (-x1)</option>
              <option value="x2">Border flash 2 (-x2)</option>
              <option value="x3">Border flash 3 (-x3)</option>
            </select></div>
          <HexField id="pack-ram" label="$01 after decrunching" value={prefs.ramExit} max={0xff} placeholder="$37 (Exomizer's default)" onCommit={v => set({ ramExit: v }, 'Pack: $01 after decrunching')} />
          <div className="field"><label htmlFor="pack-irq">Interrupts after decrunching</label>
            <select id="pack-irq" value={prefs.irqExit == null ? 'default' : prefs.irqExit ? 'on' : 'off'} onChange={e => set({ irqExit: e.target.value === 'default' ? null : e.target.value === 'on' }, 'Pack: interrupts after decrunching')}>
              <option value="default">On (Exomizer's default)</option>
              <option value="on">On (cli)</option>
              <option value="off">Off (sei)</option>
            </select></div>
        </> : <>
          <div className="field"><label htmlFor="pack-load">Load address of the crunched data</label>
            <select id="pack-load" value={typeof prefs.memLoad === 'number' ? 'addr' : prefs.memLoad} onChange={e => set({ memLoad: e.target.value === 'addr' ? (cmd.parts[0]?.start ?? 0x1000) : e.target.value as 'auto' | 'none' }, 'Pack: load address')}>
              <option value="auto">For decrunching in place</option>
              <option value="addr">This address</option>
              <option value="none">None: a plain .bin file</option>
            </select></div>
          {typeof prefs.memLoad === 'number' && <HexField id="pack-load-at" label="Load at" value={prefs.memLoad} onCommit={v => set({ memLoad: v ?? 'auto' }, 'Pack: load address')} />}
          <label className="check"><input id="pack-forward" type="checkbox" checked={prefs.forward} onChange={e => set({ forward: e.target.checked }, 'Pack: forward')} /><span>Crunch forward (-f)<small className="muted"> — the default decrunches backward</small></span></label>
          <p className="muted small">Decrunch it with Exomizer's exodecrunch.s (in the Exomizer release, exodecrs\).</p>
        </>}
        <label className="check"><input id="pack-compat" type="checkbox" checked={prefs.compat} onChange={e => set({ compat: e.target.checked }, 'Pack: compatibility')} /><span>Compatibility (-c)<small className="muted"> — no literal sequences</small></span></label>
        <label className="check"><input id="pack-fast" type="checkbox" checked={prefs.fast} onChange={e => set({ fast: e.target.checked }, 'Pack: faster crunching')} /><span>Crunch faster (-C)<small className="muted"> — a little larger</small></span></label>
        <TextField id="pack-extra" label="More Exomizer options" value={prefs.extra} placeholder="-p 4 -Di_line_number=1987" error={extraProblem(prefs.extra)} onCommit={v => set({ extra: v }, 'Pack: options')} />
        <TextField id="pack-out" label="File name" value={prefs.out} placeholder={cmd.out} onCommit={v => set({ out: v }, 'Pack: file name')} />
      </SideSection>

      <SideSection id="pack-command" title="Command">
        <pre className="pack-cmd mono" aria-label="Exomizer command">{cmd.text}</pre>
        {problem && <p className="err-text small">{problem}</p>}
        <button className="btn primary pack-go" disabled={!ready} onClick={p.onPack} title="Build and verify with Build & Run's toolchain, then pack the result">
          <Icon name="download" size={14} />{busy ?? 'Pack'}</button>
        <p className="muted small">Pack builds and verifies the program first, like Build &amp; Run, then packs the PRG it built.</p>
        {result && <PackResultCard result={result} fresh={fresh} onRun={p.onRun} onSave={p.onSave} onLog={p.onLog} />}
      </SideSection>
    </div>
  );
}

function PackResultCard({ result: r, fresh, onRun, onSave, onLog }: { result: PackResult; fresh: boolean; onRun: () => void; onSave: () => void; onLog: () => void }) {
  if (!r.ok) {
    return (
      <div className="pack-result bad" role="status">
        <div className="pack-result-head"><Icon name="err" size={14} /><b>Exomizer failed</b></div>
        <div className="small">{r.error}</div>
        <div className="bm-actions"><button className="btn small" onClick={onLog}>Show output</button></div>
      </div>);
  }
  const size = r.prg?.length ?? 0, from = r.packed?.length ?? 0;
  const sfx = r.argv[1] === 'sfx';
  const after = (what: string) => r.report.decruncher.find(d => d.what === what)?.exit;
  return (
    <div className={cx('pack-result', r.check?.status === 'differs' ? 'bad' : 'ok', !fresh && 'stale')} role="status" aria-label="Packed file">
      <div className="pack-result-head"><Icon name={r.check?.status === 'differs' ? 'err' : 'ok'} size={14} /><b className="mono" title={r.path}>{r.name}</b></div>
      <div className="small">{from ? <>{from} bytes packed to {size} ({Math.round((size / from) * 100)} %)</> : null}{r.packed ? <span className="muted mono"> · ${h4(r.packed.start)}–${h4(r.packed.start + r.packed.length - 1)}</span> : null}</div>
      {r.check && <div className={cx('small', r.check.status === 'same' ? 'ok-text' : r.check.status === 'differs' ? 'err-text' : 'muted')}>{r.check.text}</div>}
      {!sfx && <div className="muted small">Crunched data: not run or checked here.</div>}
      {r.report.layout.length > 0 && <table className="pack-layout mono small" aria-label="Memory layout"><tbody>
        {r.report.layout.map(a => <tr key={a.name}><td>{a.name}</td><td>${h4(a.start)}–${h4(a.end - 1)}</td></tr>)}
      </tbody></table>}
      {r.report.layout.filter(a => a.note).map(a => <div key={a.name} className="muted small">{a.name} also uses {a.note!.replace(/^and /, '')}</div>)}
      {sfx && (after('RAM config') || after('IRQ enabled')) && <div className="muted small">After decrunching: $01 = {after('RAM config') ?? '?'}, interrupts {after('IRQ enabled') === '0' ? 'off' : 'on'}</div>}
      {!fresh && <div className="warn-text small">Out of date: the program or the pack settings changed since.</div>}
      <div className="bm-actions">
        {sfx && <button className="btn small primary" onClick={onRun}><Icon name="play" size={12} />Run in VICE</button>}
        <button className="btn small" onClick={onSave}><Icon name="download" size={12} />Save as…</button>
        <button className="btn small ghost" onClick={onLog}>Output</button>
      </div>
    </div>
  );
}
