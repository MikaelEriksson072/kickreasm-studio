/* Bookmarks: the user's notes on addresses. The list sits in the sidebar (Ctrl+B): a click shows the whole note, a
 * double-click goes there in the code. B opens the editor for the bookmark on the cursor line at the top of the list,
 * so the code stays in view beside it. They are kept in the project file, never in the generated source. */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { h4, type Addr, type AnalysisResult, type Bookmark, type RenderResult } from '@mimir/core';
import { Icon } from '../lib/icons';
import { parseGoto } from '../lib/goto';
import { cx } from '../lib/util';

/** the bookmarks by address */
export const bookmarkList = (bm: Record<Addr, Bookmark>): [Addr, Bookmark][] =>
  Object.entries(bm).map(([k, v]) => [Number(k), v] as [Addr, Bookmark]).sort((x, y) => x[0] - y[0]);

/** the title a new bookmark gets: the label at the address, else the address */
export const bookmarkTitle = (R: RenderResult, a: Addr) => R.labels.get(a)?.name ?? `$${h4(a)}`;

/** the bookmark being added or edited, and what the editor does */
export interface BookmarkEditing {
  /** the address the editor opened on; an existing bookmark there is edited */
  addr: Addr;
  /** the cursor line's address: the editor can take it as the bookmark's place */
  cursorAt: Addr | null;
  onSave: (from: Addr, to: Addr, b: Bookmark) => void;
  onCancel: () => void;
  /** a valid address was typed: show it in the listing */
  onPreview: (a: Addr) => void;
}

interface BookmarksViewProps {
  A: AnalysisResult; bookmarks: Record<Addr, Bookmark>; R: RenderResult; cursor: Addr | null;
  /** the bookmark whose note is shown (one at a time) */
  selected: Addr | null; onSelect: (a: Addr | null) => void;
  onGo: (a: Addr) => void; onAdd: () => void; onEdit: (a: Addr) => void; onDelete: (a: Addr) => void;
  editing: BookmarkEditing | null;
}

export function BookmarksView({ A, bookmarks, R, cursor, selected, onSelect, onGo, onAdd, onEdit, onDelete, editing }: BookmarksViewProps) {
  const [q, setQ] = useState('');
  const all = bookmarkList(bookmarks);
  const ql = q.trim().toLowerCase();
  const list = all.filter(([a, b]) => !ql || b.title.toLowerCase().includes(ql) || b.text.toLowerCase().includes(ql) || h4(a).includes(ql.replace(/^\$/, '')));
  const open = useRef<HTMLDivElement | null>(null);
  // a bookmark opened from the listing's margin is scrolled into view
  useEffect(() => { open.current?.scrollIntoView?.({ block: 'nearest' }); }, [selected]);
  // the second click of a double-click does not close the note again
  const click = (a: Addr, e: ReactMouseEvent) => { if (e.detail < 2) onSelect(selected === a ? null : a); };
  return (
    <div className="side-inner">
      <div className="side-title">Bookmarks <span className="muted">{all.length}</span><span className="grow" />
        <button className="icon-btn" title={`Add a bookmark at the cursor${cursor != null ? ` ($${h4(cursor)})` : ''} (B)`} aria-label="Add bookmark" onClick={onAdd}><Icon name="plus" size={14} /></button></div>
      {editing && <BookmarkEditor key={editing.addr} A={A} R={R} bookmarks={bookmarks} editing={editing} onDelete={onDelete} />}
      {all.length > 0 && <div className="side-search"><Icon name="search" size={14} /><label htmlFor="bm-q" className="sr-only">Filter bookmarks</label><input id="bm-q" value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by title, note or address" /></div>}
      <div className="blk-list bm-list" role="list" aria-label="Bookmarks">
        {list.map(([a, b]) => { const on = selected === a, l = R.labels.get(a); return (
          <div key={a} role="listitem" className={cx('bm-item', on && 'open', editing?.addr === a && 'editing')} ref={on ? open : undefined}>
            <button className={cx('bm-row', cursor === a && 'here')} aria-expanded={on} title="Click to show the note · double-click to go there in the code"
              onClick={e => click(a, e)} onDoubleClick={() => { onSelect(a); onGo(a); }}>
              <Icon name="bookmark" size={13} className="bm-ic" /><span className="mono bm-adr">${h4(a)}</span><span className="bm-title">{b.title || `$${h4(a)}`}</span>
            </button>
            {on && <div className="bm-body">
              {l && l.name !== b.title && <div className="mono small muted">{l.name}</div>}
              {b.text ? <div className="bm-text">{b.text}</div> : <div className="muted small">No note. Edit adds one.</div>}
              <div className="bm-actions">
                <button className="btn small primary" onClick={() => onGo(a)}><Icon name="target" size={13} />Go to</button>
                <button className="btn small" onClick={() => onEdit(a)}><Icon name="pencil" size={13} />Edit</button>
                <button className="btn small ghost" onClick={() => onDelete(a)} aria-label={`Delete bookmark $${h4(a)}`}><Icon name="trash" size={13} />Delete</button>
              </div>
            </div>}
          </div>); })}
        {!all.length && !editing && <p className="muted small bm-empty">No bookmarks yet. Press <kbd>B</kbd> on a line in the listing (or right-click → Add bookmark…) to write a note about that address.</p>}
        {all.length > 0 && !list.length && <p className="muted small bm-empty">No bookmark matches “{q}”.</p>}
      </div>
      {all.length > 0 && <p className="muted small bm-help">Click shows the note · double-click goes there · <kbd>B</kbd> adds or edits · <kbd>F2</kbd> / <kbd>Shift+F2</kbd> next / previous</p>}
    </div>
  );
}

/** Adds or edits a bookmark in the sidebar: the listing beside it shows the code at the address. */
function BookmarkEditor({ A, R, bookmarks, editing, onDelete }: { A: AnalysisResult; R: RenderResult; bookmarks: Record<Addr, Bookmark>; editing: BookmarkEditing; onDelete: (a: Addr) => void }) {
  const { addr, cursorAt, onSave, onCancel, onPreview } = editing;
  const old = bookmarks[addr];
  const [at, setAt] = useState(`$${h4(addr)}`);
  const [title, setTitle] = useState(old?.title ?? bookmarkTitle(R, addr));
  const [text, setText] = useState(old?.text ?? '');
  const labelAt = (name: string) => { for (const [a, l] of R.labels) if (l.name === name) return a; return undefined; };
  const t = parseGoto(at, labelAt);
  const to = 'addr' in t ? t.addr : null;
  const error = to == null ? 'Enter one hex address like $0810, or a label.'
    : A.owner[to] < 0 ? `No loaded byte at $${h4(to)}: a bookmark marks a place in the code.`
      : to !== addr && bookmarks[to] ? `There is already a bookmark at $${h4(to)}.` : null;
  // another valid address: the listing shows its code
  const shown = useRef(addr);
  useEffect(() => { if (to != null && !error && to !== shown.current) { shown.current = to; onPreview(to); } }, [to, error]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => { if (!error && to != null) onSave(addr, to, { title: title.trim() || bookmarkTitle(R, to), text: text.replace(/^(\s*\n)+/, '').trimEnd() }); };
  const enter = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  const heading = old ? 'Edit bookmark' : 'Add bookmark';
  return (
    <form className="bm-editor" aria-label={heading} onSubmit={e => { e.preventDefault(); save(); }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
      <div className="bm-editor-head"><Icon name="bookmark" size={14} className="bm-ic" /><b>{heading}</b><span className="grow" />
        <button type="button" className="icon-btn" aria-label="Cancel" title="Cancel (Esc)" onClick={onCancel}><Icon name="x" size={13} /></button></div>
      <div className="field"><label htmlFor="bm-addr">Address</label>
        <div className="bm-addr-row"><input id="bm-addr" className="mono" value={at} spellCheck={false} onChange={e => setAt(e.target.value)} onKeyDown={enter} />
          {cursorAt != null && cursorAt !== to && <button type="button" className="btn small" title="Use the line the cursor is on in the listing" onClick={() => setAt(`$${h4(cursorAt)}`)}>Cursor line</button>}</div></div>
      <div className="field"><label htmlFor="bm-title">Title</label><input id="bm-title" value={title} maxLength={200} onChange={e => setTitle(e.target.value)} onKeyDown={enter} autoFocus onFocus={e => e.currentTarget.select()} /></div>
      {/* labels by id: a label around the textarea would take the note into its name */}
      <div className="field"><label htmlFor="bm-text">Note</label>
        <textarea id="bm-text" value={text} maxLength={20000} rows={7} placeholder="What happens here, what to look at later…" onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } }} /></div>
      {error ? <div className="err-text small">{error}</div> : <p className="muted small">The listing shows the code at {to != null ? `$${h4(to)}` : 'the address'}. Enter in a field or Ctrl+Enter in the note saves, Esc cancels.</p>}
      <div className="bm-actions">
        <button type="submit" className="btn small primary" disabled={!!error}>Save</button>
        <button type="button" className="btn small" onClick={onCancel}>Cancel</button>
        <span className="grow" />
        {old && <button type="button" className="btn small ghost" onClick={() => onDelete(addr)}><Icon name="trash" size={13} />Delete</button>}
      </div>
    </form>
  );
}
