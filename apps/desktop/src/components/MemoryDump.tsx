/* Memory tab (spec 14.6): the loaded memory as the VICE monitor prints it. `m` shows 16 (or 8) bytes a row in hex
 * with the same bytes as text, `i` 40 bytes a row as PETSCII text and `ii` as screen codes, the inverse ones inverted.
 * The cursor and the selection are the listing's: a click puts the cursor on a byte, Shift+click or a drag selects,
 * the arrow keys move. The command field takes VICE's commands (`m 0801 08ff`, `ii 0400`); Copy writes the rows as
 * VICE does. Find searches text (as PETSCII and as screen codes) or bytes, marks every hit and steps through them. */
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import {
  clipRanges, findBlock, findInMemory, h2, h4, kindInfo, loadedRanges, monitorChar, monitorPrefix, monitorRows, monitorText, MONITOR_ROW, parseMonitorCommand,
  type Addr, type AnalysisResult, type FindAs, type MemoryMatch, type MonitorMode, type MonitorRange, type MonitorRow, type RenderResult,
} from '@mimir/core';
import { Icon } from '../lib/icons';
import { OptGroup, ViewModes, type ViewMode } from './ViewModes';
import { cx, groupOfType, ROW } from '../lib/util';
import type { Sel } from '../lib/types';
import { useUi, type MonPrefs } from '../store/ui';

const MODES: ViewMode<MonitorMode>[] = [
  { key: 'm', label: 'Hex and text', badge: 'm', name: 'Hex and text (m)', title: 'Hex and text, as the monitor command m' },
  { key: 'i', label: 'PETSCII', badge: 'i', name: 'PETSCII (i)', title: 'PETSCII text, 40 bytes a row, as the monitor command i' },
  { key: 'ii', label: 'Screen codes', badge: 'ii', name: 'Screen codes (ii)', title: 'Screen codes, 40 bytes a row, as the monitor command ii' },
];
/** what a selection can be marked as from here */
const MARKS: [string, string][] = [['text', 'Text'], ['textsc', 'Text (screen codes)'], ['bytes', 'Bytes'], ['code', 'Code']];
const FIND_AS: [FindAs, string, string][] = [['text', 'Text', 'Text as the dump shows it, as PETSCII and as screen codes, in any case'], ['bytes', 'Bytes', 'Hex bytes: a9 00 8d, and ?? for any byte']];
const MATCHED: Record<MemoryMatch['as'], string> = { petscii: 'PETSCII', screen: 'screen codes', both: 'PETSCII and screen codes', bytes: 'bytes' };

type Item = { row: MonitorRow } | { gap: MonitorRange };

interface MemoryDumpProps {
  A: AnalysisResult; R: RenderResult; cursor: Addr | null; sel: Sel | null;
  /** a click: the cursor on the byte */
  onCursor: (a: Addr) => void;
  onSelect: (start: Addr, end: Addr) => void; onClear: () => void;
  onMark: (id: string, range: { start: Addr; end: Addr }) => void;
  onShow: (a: Addr) => void;
  onCopy: (text: string) => void;
}

export function MemoryDump({ A, R, cursor, sel, onCursor, onSelect, onClear, onMark, onShow, onCopy }: MemoryDumpProps) {
  const prefs = useUi(s => s.mon), setUi = useUi(s => s.set);
  const set = (p: Partial<MonPrefs>) => setUi({ mon: { ...useUi.getState().mon, ...p } });
  const { mode, lower, colors } = prefs;
  const perRow = mode === 'm' ? prefs.perRow : MONITOR_ROW[mode];
  const ranges = useMemo(() => loadedRanges(A.owner), [A]);
  /** where a command started the rows (`m 0985`: a row at $0985, as in VICE); null: at each range's start */
  const [origin, setOrigin] = useState<Addr | null>(null);
  // the rows of each loaded range, with a line for the memory between them
  const items = useMemo(() => {
    const out: Item[] = [];
    ranges.forEach((r, i) => { if (i) out.push({ gap: { start: ranges[i - 1].end, end: r.start } }); for (const row of monitorRows([r], perRow, origin ?? undefined)) out.push({ row }); });
    return out;
  }, [ranges, perRow, origin]);
  /** the item index of the row holding `a` (or the one after, for an address that is not loaded) */
  const indexOf = (a: Addr) => {
    let lo = 0, hi = items.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1, it = items[mid]; const s = 'row' in it ? it.row.a : it.gap.start; if (s <= a) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const scroller = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0), [height, setHeight] = useState(600);
  useEffect(() => {
    const el = scroller.current; if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight)); ro.observe(el); setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const scrollTo = (a: Addr, center = true) => {
    const el = scroller.current; if (!el) return;
    const y = indexOf(a) * ROW;
    if (center) el.scrollTop = Math.max(0, y - el.clientHeight / 3);
    else if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW - el.clientHeight;
  };
  // opening the tab, or another layout, shows the cursor (or the selection)
  useEffect(() => { const a = sel?.multi ? sel.start : cursor; if (a != null) scrollTo(a); }, [mode, perRow]); // eslint-disable-line react-hooks/exhaustive-deps
  /** an address a command goes to: scrolled to once the rows of its mode are rendered */
  const pending = useRef<Addr | null>(null);
  useEffect(() => { if (pending.current != null) { scrollTo(pending.current); pending.current = null; } });

  const [hover, setHover] = useState<Addr | null>(null);
  const [cmd, setCmd] = useState(''), [cmdErr, setCmdErr] = useState<string | null>(null);
  const anchor = useRef<Addr | null>(null), dragging = useRef(false);
  const range = sel && (sel.multi || sel.end - sel.start > 1) ? { start: sel.start, end: sel.end } : null;
  const inSel = (a: Addr) => !!range && a >= range.start && a < range.end;
  const addrOf = (e: ReactMouseEvent) => { const t = (e.target as HTMLElement).closest<HTMLElement>('[data-a]'); return t ? Number(t.dataset.a) : null; };
  const pick = (a: Addr, extend: boolean) => {
    if (extend && anchor.current != null) onSelect(Math.min(anchor.current, a), Math.max(anchor.current, a) + 1);
    else { anchor.current = a; onCursor(a); }
  };
  const down = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    const a = addrOf(e); if (a == null) return;
    e.preventDefault(); scroller.current?.focus();
    pick(a, e.shiftKey); dragging.current = true;
  };
  const move = (e: ReactMouseEvent) => {
    const a = addrOf(e); setHover(a);
    if (!dragging.current || !(e.buttons & 1) || a == null || anchor.current == null) { dragging.current = false; return; }
    const s = Math.min(anchor.current, a), en = Math.max(anchor.current, a) + 1;
    if (!range || range.start !== s || range.end !== en) onSelect(s, en);
  };
  /** the loaded byte `d` bytes from `a` (over the gaps between the loaded ranges), or null at the ends */
  const step = (a: Addr, d: number): Addr | null => {
    let b = a + d;
    if (b < 0 || b > 0xffff) return null;
    if (A.owner[b] >= 0) return b;
    const r = d > 0 ? ranges.find(x => x.start > a) : [...ranges].reverse().find(x => x.end <= a);
    return r ? (d > 0 ? r.start : r.end - 1) : null;
  };
  const key = (e: KeyboardEvent) => {
    const page = Math.max(1, Math.floor(height / ROW) - 2) * perRow;
    const d = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -perRow, ArrowDown: perRow, PageUp: -page, PageDown: page } as Record<string, number>)[e.key];
    const at = cursor ?? ranges[0]?.start;
    if (d != null && at != null) {
      e.preventDefault(); e.stopPropagation();
      // the info line follows the keys, not the byte under the mouse
      setHover(null);
      const b = step(at, d); if (b == null) return;
      if (e.shiftKey) { anchor.current ??= at; onSelect(Math.min(anchor.current, b), Math.max(anchor.current, b) + 1); onCursorKeep(b); } else { anchor.current = b; onCursor(b); }
      scrollTo(b, false);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); e.stopPropagation(); copy(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); findInput.current?.select(); return; }
    if (e.key === 'F3') { e.preventDefault(); e.stopPropagation(); goHit(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape') { e.stopPropagation(); anchor.current = null; onClear(); }
  };
  // Shift+arrows: the selection grows from the anchor; the cursor shown is the moving end
  const [moving, setMoving] = useState<Addr | null>(null);
  const onCursorKeep = (b: Addr) => setMoving(b);
  useEffect(() => { if (!sel?.multi) setMoving(null); }, [sel]);
  const cur = sel?.multi && moving != null ? moving : cursor;

  // find: every hit marked in the dump, Enter and the arrows step through them from the cursor
  const [findAs, setFindAs] = useState<FindAs>('text');
  const [query, setQuery] = useState('');
  const [hitIdx, setHitIdx] = useState<number | null>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const found = useMemo(() => findInMemory(A.mem, ranges, query, findAs, lower), [A, ranges, query, findAs, lower]);
  const hits = 'matches' in found ? found.matches : [];
  useEffect(() => { setHitIdx(null); }, [found]);
  const hitMap = useMemo(() => {
    const m = new Uint8Array(0x10000);
    for (const h of hits) m.fill(1, h.start, h.end);
    if (hitIdx != null && hits[hitIdx]) m.fill(2, hits[hitIdx].start, hits[hitIdx].end);
    return m;
  }, [hits, hitIdx]);
  const goHit = (dir: 1 | -1) => {
    if (!hits.length) return;
    let i: number;
    if (hitIdx != null) i = (hitIdx + dir + hits.length) % hits.length;
    else {
      const at = cur ?? -1;
      i = dir > 0 ? hits.findIndex(h => h.start > at) : hits.map(h => h.start < at).lastIndexOf(true);
      if (i < 0) i = dir > 0 ? 0 : hits.length - 1;
    }
    setHitIdx(i);
    const h = hits[i];
    anchor.current = h.start;
    onSelect(h.start, h.end);
    scrollTo(h.start);
  };
  const findStatus = 'error' in found ? found.error
    : !query ? (findAs === 'text' ? 'Text as PETSCII and as screen codes, in any case' : 'Hex bytes: a9 00 8d, ?? for any byte')
      : !hits.length ? 'No matches'
        : `${hitIdx != null ? `${hitIdx + 1} of ` : ''}${hits.length}${found.more ? '+' : ''} match${hits.length === 1 ? '' : 'es'}${hitIdx != null ? ` · ${MATCHED[hits[hitIdx].as]}` : ''}`;

  const labelAt = (n: string) => { for (const [a, l] of R.labels) if (l.name === n) return a; return undefined; };
  const run = () => {
    const c = parseMonitorCommand(cmd, labelAt);
    if ('error' in c) { setCmdErr(c.error); return; }
    setCmdErr(null);
    if (c.mode) set({ mode: c.mode });
    if (c.start == null) return;
    if (A.owner[c.start] < 0 && !ranges.some(r => r.start > c.start! && (c.end == null || r.start < c.end))) { setCmdErr(`$${h4(c.start)} is not loaded.`); return; }
    const first = A.owner[c.start] >= 0 ? c.start : ranges.find(r => r.start > c.start!)!.start;
    anchor.current = first;
    setOrigin(first);
    if (c.end != null) onSelect(first, c.end); else onCursor(first);
    pending.current = first;
  };
  const copyRanges = () => (range ? clipRanges(ranges, range.start, range.end) : ranges);
  const copy = () => onCopy(monitorText(A.mem, copyRanges(), mode, { lower, perRow }));
  const blockText = (a: Addr) => { const b = findBlock(A.blocks, a); if (!b) return 'not loaded'; const l = R.labels.get(b.start); return `${kindInfo(b.type).label}${l ? ` ${l.name}` : ''} ($${h4(b.start)}–$${h4(b.end - 1)})`; };
  const byteText = (a: Addr) => {
    const b = A.mem[a], p = monitorChar(b, false, lower), s = monitorChar(b, true, lower);
    return [`$${h4(a)} = $${h2(b)} · ${b} · %${b.toString(2).padStart(8, '0')}`, `PETSCII ${p ? `“${p.ch}”` : 'control or graphics'}`, `screen code ${s ? `“${s.ch}”${s.inv ? ' inverse' : ''}` : 'graphics'}`, blockText(a)].join(' · ');
  };

  const first = Math.max(0, Math.floor(top / ROW) - 4), last = Math.min(items.length, Math.ceil((top + height) / ROW) + 4);
  const rows = [];
  for (let i = first; i < last; i++) {
    const it = items[i];
    if ('gap' in it) {
      rows.push(<div key={i} className="mon-row mon-gap" style={{ top: i * ROW }}>{`  $${h4(it.gap.start)}–$${h4(it.gap.end - 1)} not loaded`}</div>);
      continue;
    }
    const { a, n } = it.row;
    const cls = (x: Addr) => cx(inSel(x) && 'sel', x === cur && 'cur', x === hover && 'hov', hitMap[x] === 1 && 'hit', hitMap[x] === 2 && 'hit-cur');
    const col = (x: Addr) => (colors ? { color: `var(--g-${groupOfType(A.tm[x])})` } : undefined);
    const text = Array.from({ length: n }, (_, k) => { const x = a + k, c = monitorChar(A.mem[x], mode === 'ii', lower); return <span key={k} data-a={x} className={cx('mon-c', cls(x), !c && 'dot', c?.inv && 'inv')} style={col(x)}>{c ? c.ch : '.'}</span>; });
    rows.push(
      <div key={i} className="mon-row" style={{ top: i * ROW }}>
        <span className="mon-adr" data-a={a}>{monitorPrefix(mode, a)}</span>
        {mode === 'm' ? <>
          <span className="mon-hex">{Array.from({ length: perRow }, (_, k) => (
            <Fragment key={k}>{k > 0 && (k % 4 === 0 ? '  ' : ' ')}{k < n ? <span data-a={a + k} className={cx('mon-b', cls(a + k))} style={col(a + k)}>{h2(A.mem[a + k])}</span> : '  '}</Fragment>))}</span>
          <span className="mon-sep">{'   '}</span>
        </> : null}
        <span className="mon-txt">{text}</span>
      </div>);
  }

  const now = <>
    <b>{MODES.find(m => m.key === mode)!.label}</b>
    <span>{perRow} bytes a row</span>
    <span>{lower ? 'lower case' : 'upper case'}</span>
    {colors && <span>block colours</span>}
  </>;
  return (
    <div className="gfxv monv" aria-label="Memory as the VICE monitor shows it">
      <ViewModes label="Show memory as" modes={MODES} value={mode} onChange={k => set({ mode: k })} now={now}
        aside={<><form className="gfxv-go" onSubmit={e => { e.preventDefault(); run(); }}>
          <input aria-label="Monitor command" className={cx('mono', cmdErr && 'bad')} value={cmd} title={cmdErr ?? 'A VICE monitor command (m 0801 08ff, i 0801, ii 0400 07e7), or an address or label'} placeholder="m 0801 08ff" spellCheck={false}
            onChange={e => { setCmd(e.target.value); setCmdErr(null); }} />
          <button className="btn small" type="submit"><Icon name="target" size={13} />Go</button>
        </form>
        <button className="btn small" onClick={copy} title={range ? 'Copy the selected bytes as monitor text' : 'Copy all loaded memory as monitor text'}><Icon name="copy" size={13} />{range ? 'Copy selection' : 'Copy all'}</button></>} />
      <div className="gfxv-bar view-opts">
        {mode === 'm' && <OptGroup title="Layout">
          <label className="gfxv-field">Per row<select aria-label="Bytes per row" value={prefs.perRow} onChange={e => set({ perRow: +e.target.value as 8 | 16 })}><option value={16}>16</option><option value={8}>8 (40 columns)</option></select></label>
        </OptGroup>}
        <OptGroup title="Text">
          <label className="check gfxv-mc"><input type="checkbox" checked={lower} onChange={e => set({ lower: e.target.checked })} /><span>Lower case</span></label>
          <label className="check gfxv-mc" title="Colour the bytes by the type of their block, as in the memory map"><input type="checkbox" checked={colors} onChange={e => set({ colors: e.target.checked })} /><span>Block colours</span></label>
        </OptGroup>
        <OptGroup title="Find" className="mon-find">
          <div className="seg" role="group" aria-label="Find as">{FIND_AS.map(([k, l, t]) => <button key={k} className={cx(findAs === k && 'on')} aria-pressed={findAs === k} title={t} onClick={() => setFindAs(k)}>{l}</button>)}</div>
          <input ref={findInput} aria-label="Find in memory" className={cx('mono mon-find-q', 'error' in found && 'bad')} value={query} spellCheck={false}
            placeholder={findAs === 'text' ? 'Find text' : 'a9 00 8d'} title="Enter: the next hit from the cursor, Shift+Enter: the one before (F3 / Shift+F3 in the dump)"
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); goHit(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); setQuery(''); scroller.current?.focus(); } }} />
          <button className="icon-btn small" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!hits.length} onClick={() => goHit(-1)}><Icon name="up" size={14} /></button>
          <button className="icon-btn small" aria-label="Next match" title="Next match (Enter)" disabled={!hits.length} onClick={() => goHit(1)}><Icon name="down" size={14} /></button>
          <span className={cx('small', 'error' in found ? 'err-text' : 'muted')} role="status" aria-label="Find result">{findStatus}</span>
        </OptGroup>
      </div>
      {cmdErr && <div className="gfxv-sel err-text small" role="alert">{cmdErr}</div>}
      <div className="gfxv-sel" role="status">
        {range ? <>
          <span><b className="mono">${h4(range.start)}–${h4(range.end - 1)}</b> <span className="muted">({range.end - range.start} bytes) · {blockText(range.start)}</span></span>
          <span className="grow" />
          {MARKS.map(([id, label], i) => <button key={id} className={cx('btn small', i === 0 && 'primary')} onClick={() => onMark(id, range)}>Mark as {label}</button>)}
          <button className="btn small ghost" onClick={() => onShow(range.start)}><Icon name="list" size={13} />Show in listing</button>
        </> : <span className="muted">Click a byte to put the cursor there, Shift+click or drag to select, arrow keys to move. Double-click shows it in the listing.</span>}
      </div>
      <div className="monv-scroll" ref={scroller} tabIndex={0} aria-label="Memory dump" onScroll={e => setTop(e.currentTarget.scrollTop)} onKeyDown={key}
        onMouseDown={down} onMouseMove={move} onMouseLeave={() => setHover(null)} onMouseUp={() => { dragging.current = false; }}
        onDoubleClick={e => { const a = addrOf(e); if (a != null) onShow(a); }}>
        <div className="monv-inner" style={{ height: items.length * ROW + 8 }}>{rows}</div>
      </div>
      <div className="gfxv-info mono small">{hover != null ? byteText(hover) : cur != null && A.owner[cur] >= 0 ? byteText(cur) : ' '}</div>
    </div>
  );
}
