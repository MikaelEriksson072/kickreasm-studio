/* Listing — virtualized, interactive view of the shared line model (spec 6, "one line model, two views"). */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type MutableRefObject } from 'react';
import { findBlock, h2, h4, kickMnemonic, kindInfo, lineMove, typeInfo, TOP_LEVEL_DIRECTIVES, type Addr, type AnalysisResult, type Bookmark, type ByteMove, type ListingLine, type Token } from '@kickreasm/core';
import { cx, groupOfKind, groupOfType, ROW } from '../lib/util';
import { Icon } from '../lib/icons';
import type { Editing, ScrollReq, Sel } from '../lib/types';
import type { Gutter } from '../store/ui';
import { CycleCell, type CycleView } from './Cycles';

const TOKEN_CLASS: Record<Token['t'], string> = { lbl: 'syn-label', hw: 'syn-hw', kw: 'syn-kw', num: 'syn-num', str: 'syn-str', dir: 'syn-dir', def: 'syn-label', p: 'syn-p' };

function Tok({ t, onToken }: { t: Token; onToken: (t: Token) => void }) {
  const cls = TOKEN_CLASS[t.t] || '';
  // a raw hardware address (hwInclude "none") keeps its register for the tooltip
  if ((t.t === 'lbl' || t.t === 'hw' || t.t === 'kw' || (t.t === 'num' && t.sym)) && t.to != null) {
    return <span className={cx(cls, 'link')} title={t.sym ? `${t.sym.name} — ${t.sym.desc}` : `Go to $${h4(t.to)}`} onClick={e => { e.stopPropagation(); onToken(t); }}>{t.s}</span>;
  }
  return <span className={cls}>{t.s}</span>;
}

/** an offset written after a label (`table+1`, `music.location+$0020`): its value, or null when it is not a number */
const offsetValue = (s: string): number | null => {
  const m = /^\$([0-9a-f]+)$/i.exec(s) ?? null;
  if (m) return parseInt(m[1], 16);
  if (/^%[01]+$/.test(s)) return parseInt(s.slice(1), 2);
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
};

/** an operand's tokens; after a label with an address, `+n` is a link of its own to the label's address plus n */
function Toks({ tok, onToken }: { tok: Token[]; onToken: (t: Token) => void }) {
  const out = [];
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i], plus = tok[i + 1], n = tok[i + 2];
    out.push(<Tok key={i} t={t} onToken={onToken} />);
    if ((t.t === 'lbl' || t.t === 'kw') && t.to != null && plus?.t === 'p' && plus.s === '+' && n?.t === 'num' && !n.sym) {
      const off = offsetValue(n.s);
      if (off == null) continue;
      const to = (t.to + off) & 0xffff;
      out.push(<span key={`${i}+`} className="link offset" title={`Go to $${h4(to)} (${t.s}+${n.s})`} onClick={e => { e.stopPropagation(); onToken({ t: 'num', s: n.s, to }); }}><span className="syn-p">+</span><span className="syn-num">{n.s}</span></span>);
      i += 2;
    }
  }
  return <>{out}</>;
}

export function LineBody({ l, onToken }: { l: ListingLine; onToken: (t: Token) => void }) {
  const ind = <span className="ind" />;
  const cmt = 'cmt' in l && l.cmt ? <span className={cx('syn-comment', 'cmt', 'userCmt' in l && l.userCmt && 'user')}>// {l.cmt}</span> : null;
  switch (l.k) {
    case 'lbl': return <span className="syn-label def">{l.name}<span className="syn-p">:</span></span>;
    case 'ins': return <><span className="cp">{ind}<span className={l.ill ? 'syn-ill' : 'syn-mn'}>{kickMnemonic(l.mn)}{l.ext}</span>{l.tok.length ? ' ' : ''}<Toks tok={l.tok} onToken={onToken} /></span>{cmt}</>;
    case 'dat': return <><span className="cp">{ind}<span className="syn-dir">{l.dir}</span> <Toks tok={l.tok} onToken={onToken} /></span>{cmt}</>;
    case 'dir': { const top = !!l.tok[0] && TOP_LEVEL_DIRECTIVES.includes(l.tok[0].s); return <><span className="cp">{!top && ind}<Toks tok={l.tok} onToken={onToken} /></span>{cmt}</>; }
    case 'cmt': return <span className={cx('syn-comment', l.note && 'note', l.mark && 'mark')} title={l.note ? 'Double-click to edit' : l.mark ? 'Marked by the analysis: a part of a loader (Explorer → Loaders)' : undefined}>{l.raw ? l.text : l.text ? `// ${l.text}` : '//'}</span>;
    default: return null;
  }
}

/** where the bytes at a block's edge can go when their line is dragged by its address or bytes */
interface Moves { prev: ByteMove | null; next: ByteMove | null }
const movesOf = (A: AnalysisResult, l: ListingLine): Moves | null => {
  const prev = lineMove(A, l, 'prev'), next = lineMove(A, l, 'next');
  return prev || next ? { prev, next } : null;
};
const bytesText = (m: ByteMove) => (m.end - m.start > 1 ? `$${h4(m.start)}-$${h4(m.end - 1)}` : `$${h4(m.start)}`);
const intoText = (m: ByteMove, dir: 'prev' | 'next') => `the ${kindInfo(m.into.type).label} block ${dir === 'prev' ? 'above' : 'below'}`;
const moveTip = (mv: Moves) => ['Drag the address or the bytes into the block next to it:', mv.prev && `↑ ${bytesText(mv.prev)} into ${intoText(mv.prev, 'prev')}`, mv.next && `↓ ${bytesText(mv.next)} into ${intoText(mv.next, 'next')}`].filter(Boolean).join('\n');

interface ListingProps {
  /** the visible lines (folded blocks show only their header), their numbers in the .asm file, and the folds */
  lines: ListingLine[]; lineNo: Int32Array; folded: ReadonlySet<Addr>; hidden: Map<number, number>; onToggleFold: (blockStart: Addr) => void;
  /** starts of the blocks left out of the build (their rows are dimmed) */
  excluded: ReadonlySet<Addr>;
  A: AnalysisResult; lineOf: Int32Array; cursor: Addr | null; sel: Sel | null;
  /** the `.label` line in the file head clicked last: marked instead of the cursor's line (they all share one address) */
  picked?: number | null;
  onClickLine: (l: ListingLine, i: number, e: ReactMouseEvent, dbl?: boolean) => void;
  /** the pointer was dragged (left button held) onto line `l` */
  onDragTo: (l: ListingLine) => void;
  /** a line at a block's edge was dragged by its address or bytes and dropped in the block next to it */
  onMove: (m: ByteMove) => void;
  onToken: (t: Token) => void; onContext: (e: ReactMouseEvent, l: ListingLine) => void;
  scrollReq: ScrollReq | null; editing: Editing | null; onCommitEdit: (v: string) => void; onCancelEdit: () => void;
  labelError: string | null; setLabelError: (e: string | null) => void; listRef: MutableRefObject<HTMLDivElement | null>;
  /** left column: memory address (default) or line number in the .asm file */
  gutter: Gutter;
  /** the user's bookmarks: their lines get a mark in the left margin, which opens the note in the Bookmarks list */
  bookmarks: Record<Addr, Bookmark>; onBookmark: (a: Addr) => void;
  /** cycle counting on: the cycles column and the counted range */
  cycles?: CycleView | null;
}

export function Listing({ lines, lineNo, folded, hidden, onToggleFold, excluded, A, lineOf, cursor, picked, sel, onClickLine, onDragTo, onMove, onToken, onContext, scrollReq, editing, onCommitEdit, onCancelEdit, labelError, setLabelError, listRef, gutter, bookmarks, onBookmark, cycles }: ListingProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el); setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Drag to select: rows have a fixed height, so the line under the pointer follows from its y position
  // (the list is virtualized). Above or below the listing it scrolls, faster the further out the pointer is.
  // A line at a block's edge dragged by its address or bytes moves instead: dropped in the block next to it, its
  // bytes join that block (`moving` shows where they go).
  const latest = useRef({ lines, onDragTo, onMove, A });
  latest.current = { lines, onDragTo, onMove, A };
  const drag = useRef<{ i: number; y: number; move?: { from: number; moves: Moves; m: ByteMove | null } } | null>(null);
  const [moving, setMoving] = useState<{ from: number; over: number; moves: Moves; m: ByteMove | null } | null>(null);
  const dragTo = (y: number) => {
    const d = drag.current, el = box.current; if (!d || !el) return;
    const { lines: ls, onDragTo: cb, A: an } = latest.current;
    const i = Math.max(0, Math.min(ls.length - 1, Math.floor((y - el.getBoundingClientRect().top + el.scrollTop) / ROW)));
    if (i === d.i) return;
    if (d.move) {
      // the bytes go into the block under the pointer when it is the one before or after theirs
      const t = ls[i], b = t.k === 'blank' || t.k === 'file' ? null : findBlock(an.blocks, t.a), { prev, next } = d.move.moves;
      d.i = i;
      d.move.m = b && prev && b.start === prev.into.start ? prev : b && next && b.start === next.into.start ? next : null;
      setMoving({ ...d.move, over: i });
      return;
    }
    if (ls[i].k === 'blank' || ls[i].k === 'file') return;
    d.i = i; cb(ls[i]);
  };
  const startDrag = (i: number, y: number, moves: Moves | null) => {
    const d = { i, y, ...(moves ? { move: { from: i, moves, m: null } } : {}) };
    drag.current = d;
    const tick = () => {
      const el = box.current;
      if (drag.current !== d || !el) return;
      const r = el.getBoundingClientRect();
      const over = d.y < r.top + ROW ? d.y - r.top - ROW : d.y > r.bottom - ROW ? d.y - r.bottom + ROW : 0;
      if (over) { el.scrollTop += Math.sign(over) * Math.min(ROW * 8, 2 + Math.ceil(Math.abs(over) / 3)); dragTo(d.y); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  useEffect(() => {
    /** the button is up: a move dropped in the block next to it happens; Esc, leaving the window or losing the button cancel it */
    const end = (drop: boolean) => {
      const d = drag.current; drag.current = null;
      if (!d?.move) return;
      setMoving(null);
      if (drop && d.move.m) latest.current.onMove(d.move.m);
    };
    const move = (e: MouseEvent) => { const d = drag.current; if (!d) return; if (!(e.buttons & 1)) { end(false); return; } d.y = e.clientY; dragTo(e.clientY); };
    const up = () => end(true), blur = () => end(false);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && drag.current?.move) { e.preventDefault(); e.stopPropagation(); end(false); } };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); window.addEventListener('blur', blur); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); window.removeEventListener('blur', blur); window.removeEventListener('keydown', key, true); drag.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const down = (l: ListingLine, i: number, e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    // no native text selection while dragging a range; keep the keyboard on the listing
    e.preventDefault(); box.current?.focus();
    onClickLine(l, i, e);
    // by its address or bytes, a line at a block's edge moves into the block next to it; elsewhere a drag selects
    const handle = !e.shiftKey && l.k !== 'hdr' && (e.target as HTMLElement).closest('.adr, .hex');
    startDrag(i, e.clientY, handle ? movesOf(A, l) : null);
  };
  useEffect(() => {
    if (!scrollReq || !box.current) return;
    const i = lineOf[scrollReq.addr];
    if (i < 0) return;
    let j = i; while (j > 0 && lines[j - 1].a === lines[i].a && ['lbl', 'hdr', 'dir', 'cmt'].includes(lines[j - 1].k) && i - j < 6) j--;
    const el = box.current, vis = el.clientHeight;
    const y = j * ROW;
    if (scrollReq.center || y < el.scrollTop || (i + 1) * ROW > el.scrollTop + vis) el.scrollTop = Math.max(0, y - Math.floor(vis / 3));
  }, [scrollReq]); // eslint-disable-line react-hooks/exhaustive-deps
  const curLine = picked ?? (cursor != null ? lineOf[cursor] : -1);
  // the counted range's instructions, by address
  const steps = useMemo(() => new Map((cycles?.path?.steps ?? []).map(s => [s.pc, s])), [cycles?.path]);
  // the line each bookmark is on (a folded block's header holds the bookmarks inside it)
  const marks = useMemo(() => {
    const m = new Map<number, Addr[]>();
    for (const k of Object.keys(bookmarks)) { const a = Number(k), i = lineOf[a]; if (i >= 0) m.set(i, [...(m.get(i) || []), a].sort((x, y) => x - y)); }
    return m;
  }, [bookmarks, lineOf]);
  const mark = (i: number) => {
    const at = marks.get(i); if (!at) return null;
    const b = bookmarks[at[0]];
    const note = at.length === 1 && b.text ? `\n\n${b.text.length > 300 ? b.text.slice(0, 300) + '…' : b.text}` : '';
    const tip = at.map(a => `Bookmark $${h4(a)}: ${bookmarks[a].title}`).join('\n') + note + '\n\nClick to open the note';
    return <button className="bm-mark" aria-label={`Bookmark $${h4(at[0])}: ${b.title}`} title={tip} onMouseDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onBookmark(at[0]); }}><svg viewBox="0 0 8 11" width="8" height="11" aria-hidden="true"><path d="M0 0h8v11L4 8 0 11z" /></svg></button>; };
  // with data shown as code the listing no longer matches the .asm file line for line: addresses then
  const byLine = gutter === 'line' && !lines.some(l => 'preview' in l && l.preview);
  const first = Math.max(0, Math.floor(top / ROW) - 10), last = Math.min(lines.length, Math.ceil((top + height) / ROW) + 10);
  const rows = [];
  for (let i = first; i < last; i++) {
    const l = lines[i];
    const n = 'n' in l ? l.n : 0;
    const blk = l.a != null ? findBlock(A.blocks, l.a) : null;
    const g = blk ? groupOfKind(blk.type) : null;
    const isSel = sel && n > 0 && l.a >= sel.start && l.a < sel.end;
    const bytes = n > 0 ? [...A.mem.subarray(l.a, l.a + Math.min(n, 3))].map(h2).join(' ') + (n > 3 ? ' …' : '') : '';
    const drop = !!(moving?.m && blk && blk.start === moving.m.into.start);
    if (l.k === 'hdr') {
      const hg = groupOfType(l.type);
      const inSel = !!(sel && sel.multi && blk && blk.start >= sel.start && blk.end <= sel.end);
      // the loaders this block holds a part of
      const lparts = blk ? A.loaders.flatMap(f => f.parts.filter(p => p.start < blk.end && p.end > blk.start).map(p => ({ f, p }))) : [];
      rows.push(<div key={i} className={cx('row', 'hdr', inSel && 'sel', l.preview && 'preview', drop && 'drop-into')} style={{ top: i * ROW }} onMouseDown={e => down(l, i, e)} onContextMenu={e => onContext(e, l)}>
        <span className="gut" style={{ background: `var(--g-${hg})` }} />{mark(i)}<span className={cx('adr', byLine && 'lno')}>{byLine ? lineNo[i] : h4(l.a)}</span>
        <button className="fold" aria-label={folded.has(l.a) ? 'Unfold block' : 'Fold block'} aria-expanded={!folded.has(l.a)} title={folded.has(l.a) ? 'Unfold (F)' : 'Fold (F)'}
          onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onToggleFold(l.a); }}><Icon name={folded.has(l.a) ? 'chevron' : 'down'} size={12} /></button>
        <span className="hdr-chip" style={{ '--c': `var(--g-${hg})` } as React.CSSProperties}>{typeInfo(l.type).label}</span>
        <span className="hdr-text">{l.text}</span>{l.excluded && <span className="hdr-excluded" title="Left out of the build: the block stays in the source under #if, its labels in #else">not built</span>}{l.binary && <span className="hdr-binary" title={`Saved as ${l.binary} and loaded with .import binary`}>binary</span>}{l.preview && <span className="hdr-preview" title="Shown as code; the export still writes this block as it is classified">as code</span>}{blk && blk.user && <span className="hdr-user" title="Type set by you"><Icon name="pencil" size={12} /></span>}{lparts.length > 0 && <span className="hdr-loader" title={lparts.map(({ f, p }) => `${f.name}: ${p.what}`).join('\n')}>{[...new Set(lparts.map(({ f }) => f.name.replace(/ \(.*$/, '')))].join(', ')}</span>}
        {hidden.has(i) && <span className="hdr-folded">{hidden.get(i)} line{hidden.get(i) === 1 ? '' : 's'} folded</span>}
        {blk && !blk.user && blk.conf < 0.7 && <span className="hdr-conf" title={`Low confidence: ${blk.reason}`}>?</span>}
      </div>);
      continue;
    }
    if (l.k === 'file') { rows.push(<div key={i} className="row filebar" style={{ top: i * ROW }}><Icon name="doc" size={13} /> {l.text}</div>); continue; }
    // blank lines are rows of their own only when the line numbers would otherwise skip them
    if (l.k === 'blank') { if (byLine) rows.push(<div key={i} className="row k-blank" style={{ top: i * ROW }}><span className="gut" /><span className="adr lno">{lineNo[i]}</span></div>); continue; }
    // only a line at a block's edge can move into the block next to it
    const mv = blk && n > 0 && (l.a === blk.start || l.a + n === blk.end) ? movesOf(A, l) : null, tip = mv ? moveTip(mv) : undefined;
    rows.push(
      <div key={i} className={cx('row', `k-${l.k}`, isSel && 'sel', i === curLine && 'cur', 'preview' in l && l.preview && 'preview', 'delay' in l && l.delay && 'delay', blk && excluded.has(blk.start) && 'excluded', cycles && steps.get(l.a) && !steps.get(l.a)!.counted && l.k === 'ins' && 'cy-skip', mv && 'movable', drop && 'drop-into', moving?.from === i && 'moving-src')} style={{ top: i * ROW }}
        onMouseDown={e => down(l, i, e)} onDoubleClick={e => onClickLine(l, i, e, true)} onContextMenu={e => onContext(e, l)}>
        <span className="gut" style={g ? { background: `var(--g-${g})` } : undefined} />{mark(i)}
        <span className={cx('adr', byLine && 'lno')} title={tip}>{byLine ? lineNo[i] : n > 0 || l.k === 'lbl' ? h4(l.a) : ''}</span>
        <span className="hex" title={tip}>{bytes}</span>
        {cycles && <CycleCell l={l} A={A} step={steps.get(l.a)} taken={cycles.taken} onToggle={cycles.onToggle} />}
        <span className="src"><LineBody l={l} onToken={onToken} />{l.k === 'dir' && l.zp != null && <span className="zp-tag" title={`Zero-page variable $${h2(l.zp)}: double-click or N renames it everywhere; ; / * comment it`}>zero page</span>}{'delay' in l && l.delay && <span className="zp-tag delay-tag" title="Timing code: a branch that a timer sets goes part of the way into these instructions, so they only take time (their operands are no data)">delay</span>}</span>
      </div>);
  }
  let pop = null;
  if (editing) {
    // a .label line in the file head has no line of the label's own address: the editor opens under that line
    const i = editing.line ?? lineOf[editing.addr];
    if (i != null && i >= 0) {
      let j = i; while (editing.line == null && j > 0 && lines[j - 1].a === editing.addr && lines[j - 1].k === 'lbl') j--;
      // a comment line or block goes above the labels: open the editor at its first line
      // (a zero-page variable's comment lines carry its address in `zp`)
      if (editing.kind === 'note') while (j > 0 && (editing.zp ? (lines[j - 1] as { zp?: Addr }).zp : lines[j - 1].a) === editing.addr && lines[j - 1].k === 'cmt' && (lines[j - 1] as { note?: boolean }).note) j--;
      pop = <EditPopover key={editing.kind + editing.addr + (editing.block ? 'b' : '')} top={(editing.kind === 'comment' ? i : j) * ROW + ROW + 2} editing={editing} onCommit={onCommitEdit} onCancel={onCancelEdit} error={labelError} setError={setLabelError} />;
    }
  }
  let chip = null;
  if (moving) {
    const { m, moves } = moving, dir = m && m === moves.prev ? 'prev' : 'next';
    const text = m ? `${dir === 'prev' ? '↑' : '↓'} Move ${bytesText(m)} into ${intoText(m, dir)}`
      : `Drop it in ${[moves.prev && intoText(moves.prev, 'prev'), moves.next && intoText(moves.next, 'next')].filter(Boolean).join(' or ')} · Esc cancels`;
    chip = <div className={cx('move-chip', m && 'ok')} role="status" style={{ top: moving.over * ROW + ROW + 2 }}>{text}</div>;
  }
  return (
    <div className={cx('listing', moving && 'moving')} ref={el => { box.current = el; listRef.current = el; }} tabIndex={0} onScroll={e => setTop(e.currentTarget.scrollTop)} aria-label="Disassembly listing">
      <div style={{ height: lines.length * ROW + 40, position: 'relative' }}>{rows}{pop}{chip}</div>
    </div>
  );
}

function EditPopover({ top, editing, onCommit, onCancel, error, setError }: { top: number; editing: Editing; onCommit: (v: string) => void; onCancel: () => void; error: string | null; setError: (e: string | null) => void }) {
  const [v, setV] = useState(editing.value || '');
  const ref = useRef<HTMLInputElement>(null), area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = area.current || ref.current; el?.focus(); el?.select(); }, []);
  const at = editing.zp ? `$${h2(editing.addr)}` : `$${h4(editing.addr)}`;
  const title = editing.kind === 'label' ? (editing.zp ? `Zero-page variable at ${at}` : `Label at ${at}`) : editing.kind === 'comment' ? `Comment at ${at}` : `Comment ${editing.block ? 'block' : 'line'} above ${at}`;
  const help = editing.kind === 'label' && editing.zp ? `Every access to ${at} (and to ${at}+1 for a pointer) uses this name · Enter renames · empty restores the automatic name · Esc cancels`
    : editing.kind === 'label' ? 'Enter to rename everywhere · empty restores the automatic name · Esc cancels'
    : editing.kind === 'note' && editing.block ? 'Written as /* … */ · Ctrl+Enter saves · empty removes the block · Esc cancels'
      : editing.kind === 'note' ? 'Written as its own // line · Enter saves · empty removes it · Esc cancels'
        : 'Enter to save · empty removes the comment';
  return (
    <div className={cx('edit-pop', editing.zp && 'zp')} style={{ top }} onMouseDown={e => e.stopPropagation()}>
      <label htmlFor="edit-pop-input">{title}{editing.zp && <span className="zp-tag">zero page</span>}</label>
      {editing.kind === 'note' && editing.block ? <>
        <textarea id="edit-pop-input" ref={area} value={v} rows={Math.min(12, Math.max(3, v.split('\n').length + 1))} spellCheck={false}
          onChange={e => setV(e.target.value)}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onCommit(v); } if (e.key === 'Escape') onCancel(); }} />
        <div className="edit-actions"><button className="btn small" onClick={onCancel}>Cancel</button><button className="btn primary small" onClick={() => onCommit(v)}>Save</button></div>
      </> : (
        <input id="edit-pop-input" ref={ref} value={v} spellCheck={false} className={cx(editing.kind === 'label' && 'mono')}
          onChange={e => { setV(e.target.value); setError(null); }}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') onCommit(v); if (e.key === 'Escape') onCancel(); }} />
      )}
      <div className="edit-help">{error ? <span className="err-text">{error}</span> : help}</div>
    </div>
  );
}
