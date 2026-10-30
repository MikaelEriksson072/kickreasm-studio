import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../lib/icons';
import { cx } from '../lib/util';
import type { ContextMenuState } from '../lib/types';

const MARGIN = 8;

export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  useEffect(() => { const c = () => onClose(); window.addEventListener('mousedown', c); window.addEventListener('blur', c); return () => { window.removeEventListener('mousedown', c); window.removeEventListener('blur', c); }; }, [onClose]);
  // Escape closes the menu, and only that (in the listing it would go back too): caught before the app's keys
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [onClose]);
  const [sub, setSub] = useState<number | null>(null);
  // placed at the pointer, then moved so all of it is inside the window (measured: the menu's length varies);
  // a menu taller than the window scrolls
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number }>({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.scrollHeight, W = window.innerWidth, H = window.innerHeight;
    const fits = h <= H - 2 * MARGIN;
    setPos({
      left: Math.max(MARGIN, Math.min(menu.x, W - w - MARGIN)),
      top: fits ? Math.max(MARGIN, Math.min(menu.y, H - h - MARGIN)) : MARGIN,
      ...(fits ? {} : { maxHeight: H - 2 * MARGIN }),
    });
  }, [menu]);
  return (
    <div ref={ref} className="ctx" style={{ left: pos.left, top: pos.top, ...(pos.maxHeight ? { maxHeight: pos.maxHeight, overflowY: 'auto' } : {}) }} onMouseDown={e => e.stopPropagation()} role="menu">
      {menu.items.map((it, i) => 'sep' in it ? <div key={i} className="ctx-sep" /> : 'children' in it ? (
        <div key={i} className="ctx-item has-sub" onMouseEnter={() => setSub(i)}><span>{it.label}</span><Icon name="chevron" size={12} />
          {sub === i && <div className="ctx sub">{it.children.map((c, j) => <button key={j} className="ctx-item" role="menuitem" onClick={() => { onClose(); c.run(); }}><span>{c.label}</span>{c.key && <kbd>{c.key}</kbd>}</button>)}</div>}
        </div>
      ) : <button key={i} className={cx('ctx-item', it.checked != null && 'checkable')} role={it.checked != null ? 'menuitemcheckbox' : 'menuitem'} aria-checked={it.checked} onMouseEnter={() => setSub(null)} onClick={() => { onClose(); it.run(); }}>
        <span>{it.checked != null && <span className="ctx-check">{it.checked && <Icon name="check" size={12} />}</span>}{it.label}</span>{it.key && <kbd>{it.key}</kbd>}</button>)}
    </div>
  );
}
