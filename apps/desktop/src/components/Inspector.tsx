/* Inspector (right column): memory map, block evidence/type/label/comment (or the zero-page variable whose .label line
 * was clicked: its name and comments), graphics/music/text preview. */
import { useEffect, useMemo, useState } from 'react';
import { textEncoding, ALL_BANKS, bankRange, banksOf, describePorts, findBlock, h2, h4, kindInfo, MARK_AS, mergeOverride, OPC, portName, portsOf, portText, type Addr, type AnalysisResult, type Block, type CyclePath, type Project, type RenderResult, FORMATTABLE, type NumberFormat } from '@mimir/core';
import type { TypeGroup } from '@mimir/core';
import { Icon } from '../lib/icons';
import { cx, GROUP_LABEL, GROUP_ORDER, groupOfType } from '../lib/util';
import type { Sel } from '../lib/types';
import { useUi } from '../store/ui';
import { Heatmap, type CanvasColors, type HeatMode } from './Heatmap';
import { GfxPreview, type GfxMode } from './GfxPreview';
import { CyclesSection } from './Cycles';

interface InspectorProps {
  A: AnalysisResult; R: RenderResult; project: Project; cursor: Addr | null; sel: Sel | null; colors: CanvasColors;
  heatMode: HeatMode; setHeatMode: (m: HeatMode) => void;
  onNavigate: (a: Addr) => void; onSelect: (s: Addr, e: Addr) => void;
  onMark: (id: string, range: { start: Addr; end: Addr }) => void; onRename: (a: Addr, name: string) => void;
  onBlockComment: (a: Addr, text: string) => void; onClearOverride: (b: Block) => void;
  onBankZone: (range: { start: Addr; end: Addr }, part: 'port' | 'vicBank', v: number | null) => void;
  onMerge: (dir: 'prev' | 'next', at: Addr) => void;
  /** open the Merge range dialog (start and type from this block) */
  onMergeRange: () => void;
  onToggleExcluded: (at: Addr) => void;
  /** save the block as data/<label>.bin (loaded with .import binary), or write it in the source again */
  onToggleBinary: (at: Addr) => void;
  /** the number format of a data, table or word block (null: the default) and how many items a row (null: the default) */
  onFormat: (b: Block, change: { fmt?: NumberFormat | null; row?: number | null }) => void;
  /** cycle counting on: the counted range and how to mark a branch as taken */
  cycles?: { path: CyclePath; onToggle: (pc: Addr) => void } | null;
  /** the zero-page variable whose `.label` line in the file head was clicked (it has no block of its own) */
  zpVar?: Addr | null;
  /** its comment lines above the `.label` line (Project.notes) and the comment at the end of it (Project.comments) */
  onZpNote?: (a: Addr, text: string) => void; onZpComment?: (a: Addr, text: string) => void;
}

const MARK_ID: Record<string, string> = { code: 'code', data: 'bytes', words: 'words', table: 'table', sprite: 'sprite', charset: 'charset', bitmap: 'bitmap', screen: 'screen', music: 'music', fill: 'fill' };

export function Inspector({ A, R, project, cursor, sel, colors, heatMode, setHeatMode, onNavigate, onSelect, onMark, onRename, onBlockComment, onClearOverride, onBankZone, onMerge, onMergeRange, onToggleExcluded, onToggleBinary, onFormat, cycles, zpVar, onZpNote, onZpComment }: InspectorProps) {
  const blk = cursor != null ? findBlock(A.blocks, cursor) : null;
  const fit = useUi(s => s.heatFit), setUi = useUi(s => s.set);
  const [view, setView] = useState<'auto' | GfxMode>('auto');
  const [mc, setMc] = useState(false);
  useEffect(() => { setView('auto'); }, [blk?.start]);
  const range = sel && sel.multi ? sel : blk ? { start: blk.start, end: blk.end } : null;
  const autoMode: GfxMode | null = blk ? (blk.type === 'sprite' ? 'sprite' : blk.type === 'charset' ? 'chars' : blk.type === 'bitmap' ? 'bitmap' : null) : null;
  const mode = view === 'auto' ? autoMode : view;
  const groups = useMemo(() => { const g: Partial<Record<TypeGroup, number>> = {}; for (const [t, n] of Object.entries(A.stats.bytesByType)) { const k = groupOfType(+t); g[k] = (g[k] || 0) + n; } return g; }, [A]);
  const lb = blk ? R.labels.get(blk.start) : undefined;
  const [nameV, setNameV] = useState(''); const [cmtV, setCmtV] = useState('');
  useEffect(() => { setNameV(lb ? lb.name : ''); setCmtV(blk ? (project.blockComments[blk.start] || '') : ''); }, [blk?.start, lb?.name, project.blockComments]); // eslint-disable-line react-hooks/exhaustive-deps
  const TEXT_ID: Record<string, string> = { petscii: 'text', screen: 'textsc', 'petscii-mixed': 'textmix', 'screen-mixed': 'textscmix' };
  const markId = blk ? (blk.type === 'text' ? TEXT_ID[blk.props.enc ?? 'petscii'] ?? 'text' : MARK_ID[blk.type] || '') : '';
  const music = blk && blk.type === 'music' ? A.music.find(m => m.start === blk.start) : null;
  // the characters the export writes in .text (textEncoding); RETURN and the PETSCII terminator get their own marks
  const te = blk && blk.type === 'text' ? textEncoding(blk.props.enc) : null;
  const textPreview = blk && te ? [...A.mem.subarray(blk.start, Math.min(blk.end, blk.start + 120))].map(b => b === 0x0d && te.kick.startsWith('petscii') ? '⏎' : te.char(b) ?? (b === 0 ? '·' : '░')).join('') : null;
  const xin = blk ? (A.xrefs.get(blk.start) || []).length : 0;
  return (
    <div className="inspector">
      {cycles && <CyclesSection path={cycles.path} R={R} onToggle={cycles.onToggle} onNavigate={onNavigate} />}
      <section className="insp-sec">
        <div className="sec-head"><span>Memory map</span>
          <div className="seg" role="group" aria-label="Heatmap mode">{([['type', 'Type'], ['bytes', 'Bytes'], ['refs', 'Refs']] as const).map(([k, l]) => <button key={k} className={cx(heatMode === k && 'on')} aria-pressed={heatMode === k} onClick={() => setHeatMode(k)}>{l}</button>)}</div>
        </div>
        <Heatmap A={A} mode={heatMode} cursor={cursor} sel={sel} onNavigate={onNavigate} onSelect={onSelect} colors={colors} fit={fit} />
        <ul className="legend compact">{GROUP_ORDER.filter(g => groups[g]).map(g => <li key={g}><i style={{ background: `var(--g-${g})` }} />{GROUP_LABEL[g]}</li>)}</ul>
        <label className="check small"><input id="heat-fit" type="checkbox" checked={fit} onChange={e => setUi({ heatFit: e.target.checked })} /> Zoom to the loaded pages (off shows all 64 KB)</label>
        <p className="muted small">Click to jump, drag to select a range. Each row is one 256-byte page.</p>
      </section>
      {zpVar != null ? <ZpSection a={zpVar} A={A} R={R} project={project} onRename={onRename} onNote={onZpNote} onComment={onZpComment} onNavigate={onNavigate} /> : blk ? (
        <section className="insp-sec">
          <div className="sec-head"><span>Block</span>{blk.user ? <span className="pill user">set by you</span> : <span className={cx('pill', blk.conf >= 0.85 ? 'hi' : blk.conf >= 0.6 ? 'mid' : 'lo')}>{blk.conf >= 0.85 ? 'high' : blk.conf >= 0.6 ? 'medium' : 'low'} confidence</span>}</div>
          <dl className="kv">
            <dt>Range</dt><dd className="mono">${h4(blk.start)}–${h4(blk.end - 1)} <span className="muted">· {blk.end - blk.start} bytes</span></dd>
            <dt>Why</dt><dd>{blk.reason || '—'}</dd>
            <dt>Refs in</dt><dd>{xin}</dd>
            <dt>Entropy</dt><dd className="mono">{blk.entropy.toFixed(2)} <span className="muted">bits/byte</span></dd>
          </dl>
          <label className="field"><span>Type</span>
            <select value={markId} onChange={e => e.target.value === 'auto' ? onClearOverride(blk) : onMark(e.target.value, { start: blk.start, end: blk.end })}>
              {MARK_AS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              {blk.type === 'lohi' && <option value="">Lo/Hi table (detected)</option>}
              {blk.type === 'basic' && <option value="">BASIC (detected)</option>}
              {blk.user && <option value="auto">Automatic (clear override)</option>}
            </select></label>
          {FORMATTABLE.includes(blk.type) && <FormatFields blk={blk} defaultRow={blk.type === 'words' ? 1 : A.S.bytesPerRow} onFormat={onFormat} />}
          <label className="check"><input type="checkbox" aria-label="Include in the build" checked={!project.excluded.includes(blk.start)} onChange={() => onToggleExcluded(blk.start)} /><span>Include in the build<small className="muted"> — when off, the block stays in the source under #if and its bytes are left out</small></span></label>
          <label className="check"><input type="checkbox" aria-label="Save as a binary file" checked={project.binary.includes(blk.start)} onChange={() => onToggleBinary(blk.start)} /><span>Save as a binary file<small className="muted"> — the export writes <span className="mono">data/{lb ? lb.name : `block_${h4(blk.start)}`}.bin</span> and the source loads it with .import binary</small></span></label>
          <div className="merge-row">
            {([['prev', 'Merge with previous'], ['next', 'Merge with next']] as const).map(([dir, label]) => { const m = mergeOverride(A, blk.start, dir); return (
              <button key={dir} className="btn small" disabled={!m} onClick={() => onMerge(dir, blk.start)}
                title={m ? `One ${kindInfo(m.into).label} block $${h4(m.override.start)}–$${h4(m.override.end - 1)} (with the ${kindInfo(m.other.type).label} block ${dir === 'prev' ? 'before' : 'after'} it)` : `No ${dir === 'prev' ? 'previous' : 'next'} block in this file`}>{label}</button>); })}
            <button className="btn small merge-range-btn" onClick={onMergeRange} title="Merge from this block to an end address into one block (M)">Merge range…</button>
          </div>
          {blk.type === 'code' && A.mcfg && <MemoryFields A={A} blk={blk} onBankZone={onBankZone} />}
          <label className="field"><span>Label</span>
            <input className="mono" value={nameV} placeholder="(no label)" spellCheck={false} onChange={e => setNameV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onRename(blk.start, nameV.trim()); }} onBlur={() => { if ((lb ? lb.name : '') !== nameV.trim()) onRename(blk.start, nameV.trim()); }} /></label>
          <label className="field"><span>Comment</span>
            <textarea rows={2} value={cmtV} placeholder="Shown above the block in the export" onChange={e => setCmtV(e.target.value)} onBlur={() => onBlockComment(blk.start, cmtV.trim())} /></label>
          {blk.type === 'code' && !blk.user && A.entryKind.get(blk.start) === 'guess' && <div className="notice small"><Icon name="hint" size={14} /> Nothing traced reaches this code; it decodes as a routine, so it is shown as code. <button className="linkish" onClick={() => onMark('bytes', { start: blk.start, end: blk.end })}>Mark as data</button></div>}
          {blk.hint === 'code' && <div className="notice small"><Icon name="hint" size={14} /> This data decodes as a plausible instruction sequence. <button className="linkish" onClick={() => onMark('code', { start: blk.start, end: blk.end })}>Mark as code</button></div>}
        </section>
      ) : <section className="insp-sec"><div className="empty small">Nothing loaded at the cursor.</div></section>}
      {blk && zpVar == null && (
        <section className="insp-sec">
          <div className="sec-head"><span>Preview</span>
            <div className="seg" role="group" aria-label="Preview as">{([['auto', 'Auto'], ['sprite', 'Sprite'], ['chars', 'Chars'], ['bitmap', 'Bitmap']] as const).map(([k, l]) => <button key={k} className={cx(view === k && 'on')} aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}</div>
          </div>
          {mode && range ? (
            <>
              <div className="gfx-box"><GfxPreview mem={A.mem} start={range.start} end={Math.max(range.end, range.start + (mode === 'bitmap' ? 8000 : mode === 'chars' ? 8 : 64))} mode={mode} mc={mc} /></div>
              <label className="check"><input type="checkbox" checked={mc} onChange={e => setMc(e.target.checked)} /> Multicolor</label>
            </>
          ) : music ? (
            <dl className="kv">
              <dt>Init</dt><dd className="mono">${h4(music.init)}</dd><dt>Play</dt><dd className="mono">${h4(music.play)}</dd>
              <dt>SID regs</dt><dd>{music.sidRegs} written</dd><dt>Evidence</dt><dd>{music.why.join(', ')}</dd>
              <dt>Export</dt><dd className="mono small">music/music_{h4(music.start)}.sid (PSID v2) via LoadSid</dd>
            </dl>
          ) : textPreview ? <pre className="text-prev">{textPreview}</pre>
            : blk.type === 'code' ? <CodeSummary A={A} blk={blk} />
              : <p className="muted small">Pick Sprite, Chars or Bitmap to view these bytes as graphics. Useful for finding unreferenced graphics.</p>}
        </section>
      )}
    </div>
  );
}

/** what a code block runs with ($01, VIC bank): detected, or set by the user for the block */
/** How a data, table or word block writes its numbers: hex, decimal or binary (bits), or for words also as addresses
 *  (labels, the default), and how many go on a row. */
function FormatFields({ blk, defaultRow, onFormat }: { blk: Block; defaultRow: number; onFormat: InspectorProps['onFormat'] }) {
  const words = blk.type === 'words';
  const fmt = blk.props.fmt ?? (words ? null : 'hex');
  const opts: [NumberFormat | null, string, string][] = [
    ...(words ? [[null, 'Addr', 'Addresses: a label where a word points into the program (.word sub_1000)'] as [null, string, string]] : []),
    ['hex', 'Hex', words ? 'Hexadecimal numbers (.word $1234)' : 'Hexadecimal (.byte $12)'],
    ['dec', 'Dec', words ? 'Decimal numbers (.word 4660)' : 'Decimal (.byte 18)'],
    ['bin', 'Bin', words ? 'Binary, the bits of each word (.word %0001001000110100)' : 'Binary, the bits of each byte (.byte %00010010)'],
  ];
  const row = blk.props.row ?? defaultRow;
  const [text, setText] = useState(String(row));
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(String(row)); setBad(false); }, [blk.start, row]);
  const take = (t = text) => {
    const n = Number(t.trim());
    if (!Number.isInteger(n) || n < 1 || n > 64) { setBad(true); return; }
    setBad(false);
    if (n !== row) onFormat(blk, { row: n === defaultRow ? null : n });
  };
  return (
    <div className="fmt-fields">
      <div className="field"><span>Format</span>
        <div className="seg fmt-seg" role="group" aria-label="Number format">
          {opts.map(([k, l, t]) => <button key={l} className={cx(fmt === k && 'on')} aria-pressed={fmt === k} title={t} onClick={() => { if (fmt !== k) onFormat(blk, { fmt: k }); }}>{l}</button>)}
        </div></div>
      <label className="field fmt-row" title={`1 to 64 ${words ? 'words' : 'bytes'} on a line of the source; ${defaultRow} is the default${words ? '' : ' (Settings → Kick Assembler output)'}`}><span>{words ? 'Words per row' : 'Bytes per row'}</span>
        <input className={cx('mono', bad && 'bad')} value={text} inputMode="numeric" spellCheck={false} onChange={e => { setText(e.target.value); setBad(false); }} onBlur={() => take()}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); take(); }
            else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const n = Math.min(64, Math.max(1, (Number(text) || row) + (e.key === 'ArrowUp' ? 1 : -1))); setText(String(n)); take(String(n)); }
          }} /></label>
    </div>
  );
}

function MemoryFields({ A, blk, onBankZone }: { A: AnalysisResult; blk: Block; onBankZone: InspectorProps['onBankZone'] }) {
  const m = A.mcfg!;
  const port = m.port[blk.start], vic = m.vic[blk.start];
  const fp = portsOf(m.forcedPort[blk.start]), fv = banksOf(m.forcedVic[blk.start]);
  const range = { start: blk.start, end: blk.end };
  const vicText = !vic || vic === ALL_BANKS ? 'unknown' : banksOf(vic).map(b => `${b} (${bankRange(b)})`).join(' or ');
  return <>
    <label className="field"><span>Memory ($01)</span>
      <select aria-label="Memory configuration ($01)" value={fp.length === 1 ? String(0x30 + fp[0]) : 'auto'} onChange={e => onBankZone(range, 'port', e.target.value === 'auto' ? null : +e.target.value)}>
        <option value="auto">{fp.length ? 'Detected (automatic)' : `Detected: ${describePorts(port, m.cart)}`}</option>
        {[7, 6, 5, 4, 3, 2, 1, 0].map(c => <option key={c} value={0x30 + c}>{portName(c)} · {portText(c, m.cart)}</option>)}
      </select></label>
    <label className="field"><span>VIC bank</span>
      <select aria-label="VIC bank" value={fv.length === 1 ? String(fv[0]) : 'auto'} onChange={e => onBankZone(range, 'vicBank', e.target.value === 'auto' ? null : +e.target.value)}>
        <option value="auto">{fv.length ? 'Detected (automatic)' : `Detected: ${vicText}`}</option>
        {[0, 1, 2, 3].map(b => <option key={b} value={b}>Bank {b} · {bankRange(b)}</option>)}
      </select></label>
  </>;
}

const ROLE: Record<string, string> = { entry: 'Program entry (SYS)', irq: 'IRQ handler', nmi: 'NMI handler', brk: 'BRK handler', sub: 'Subroutine', ptr: 'Jump-table target', user: 'Marked by you', guess: 'Unreached code' };

function CodeSummary({ A, blk }: { A: AnalysisResult; blk: Block }) {
  let n = 0, last: Addr | null = null;
  for (let p = blk.start; p < blk.end; p++) if (A.insLen[p]) { n++; last = p; }
  const kind = A.entryKind.get(blk.start);
  const callers = (A.xrefs.get(blk.start) || []).filter(x => x.kind === 'call').length;
  return (
    <dl className="kv">
      <dt>Role</dt><dd>{(kind && ROLE[kind]) || 'Code'}</dd><dt>Instructions</dt><dd>{n}</dd><dt>Callers</dt><dd>{callers}</dd>
      <dt>Ends with</dt><dd className="mono">{last != null ? OPC[A.mem[last]].mn : '—'}</dd>
    </dl>
  );
}

/** A zero-page variable (a `.label` line in the file head): its name, the code using it, and its comments, which the
 *  export writes above the `.label` line and at its end, as a block's comment goes above the block. */
function ZpSection({ a, A, R, project, onRename, onNote, onComment, onNavigate }: {
  a: Addr; A: AnalysisResult; R: RenderResult; project: Project; onRename: (a: Addr, name: string) => void;
  onNote?: (a: Addr, text: string) => void; onComment?: (a: Addr, text: string) => void; onNavigate: (a: Addr) => void;
}) {
  const z = R.zp.get(a);
  const note = project.notes[a]?.text ?? '', eol = project.comments[a] ?? '';
  const [nameV, setNameV] = useState(z?.name ?? ''); const [noteV, setNoteV] = useState(note); const [eolV, setEolV] = useState(eol);
  useEffect(() => { setNameV(z?.name ?? ''); setNoteV(note); setEolV(eol); }, [a, z?.name, note, eol]);
  // a pointer's high byte ($fc for $fb) is <name>+1: its accesses belong to the variable too
  const refs = [...(A.xrefs.get(a) || []), ...(R.zp.get(a + 1)?.off ? A.xrefs.get(a + 1) || [] : [])].sort((x, y) => x.from - y.from);
  const first = refs[0];
  return (
    <section className="insp-sec" aria-label="Zero-page variable">
      <div className="sec-head"><span>Zero-page variable</span><span className="pill user">.label</span></div>
      <dl className="kv">
        <dt>Address</dt><dd className="mono">${h2(a)}{R.zp.get(a + 1)?.off ? <span className="muted"> · pointer (${h2(a)}/${h2(a + 1)})</span> : null}</dd>
        <dt>Refs</dt><dd>{refs.length}{first && <> · <button className="linkish mono" title="Go to the first access" onClick={() => onNavigate(first.from)}>${h4(first.from)}</button></>}</dd>
      </dl>
      <label className="field"><span>Name</span>
        <input className="mono" aria-label="Zero-page variable name" value={nameV} spellCheck={false} onChange={e => setNameV(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onRename(a, nameV.trim()); }} onBlur={() => { if ((z?.name ?? '') !== nameV.trim()) onRename(a, nameV.trim()); }} /></label>
      <label className="field"><span>Comment</span>
        <textarea rows={2} aria-label="Comment above the .label line" value={noteV} placeholder="Written above the .label line in the export" onChange={e => setNoteV(e.target.value)} onBlur={() => { if (noteV.trim() !== note.trim()) onNote?.(a, noteV.replace(/^(\s*\n)+/, '').trimEnd()); }} /></label>
      <label className="field"><span>End-of-line comment</span>
        <input aria-label="Comment at the end of the .label line" value={eolV} placeholder="After .label … = $xx" onChange={e => setEolV(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onComment?.(a, eolV.trim()); }} onBlur={() => onComment?.(a, eolV.trim())} /></label>
      <p className="muted small">In the listing: <kbd>;</kbd> comments the end of the .label line, <kbd>/</kbd> and <kbd>*</kbd> add a comment line or block above it, <kbd>N</kbd> renames.</p>
    </section>
  );
}
