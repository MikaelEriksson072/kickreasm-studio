/* A section of the side panel (the Explorer's, the Pack view's): a card whose title folds it up, the user's choice kept. */
import type { ReactNode } from 'react';
import { Icon } from '../lib/icons';
import { cx } from '../lib/util';
import { useUi } from '../store/ui';

/** A section of the side panel: its title folds it up, `summary` says what it holds, `actions` sit at the right. */
export function SideSection({ id, title, summary, actions, className, children }: { id: string; title: string; summary?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  const closed = useUi(s => s.sideClosed.includes(id)), setUi = useUi(s => s.set);
  const toggle = () => { const now = useUi.getState().sideClosed; setUi({ sideClosed: closed ? now.filter(x => x !== id) : [...now, id] }); };
  return (
    <section className={cx('side-sec', closed && 'closed', className)} aria-label={title}>
      <div className="sec-head">
        <button className="sec-toggle" aria-expanded={!closed} title={closed ? `Show ${title.toLowerCase()}` : `Fold ${title.toLowerCase()} up`} onClick={toggle}>
          <Icon name="down" size={13} /><span>{title}</span>
        </button>
        {summary != null && <span className="sec-sum">{summary}</span>}
        {actions}
      </div>
      {!closed && <div className="sec-body">{children}</div>}
    </section>
  );
}
