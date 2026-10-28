/* The mode switch over the Graphics and Memory tabs: the mode the view is in stands out (filled with the accent), each
 * with its icon or monitor command and what one cell is, and a line beside it says what the view shows now. */
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../lib/icons';
import { cx } from '../lib/util';

export interface ViewMode<K extends string> {
  key: K;
  label: string;
  /** the accessible name, when it is not the label */
  name?: string;
  icon?: IconName;
  /** a short code shown as a key (the VICE monitor's m, i, ii) */
  badge?: string;
  /** what one cell is: 8×8, 24×21, … */
  sub?: string;
  title?: string;
}

/** `now`: what the view shows; `aside`: controls at the right end (going to an address) */
export function ViewModes<K extends string>({ label, modes, value, onChange, now, aside }: { label: string; modes: ViewMode<K>[]; value: K; onChange: (k: K) => void; now?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="view-head">
      <div className="view-modes" role="group" aria-label={label}>
        {modes.map(m => (
          <button key={m.key} className={cx(value === m.key && 'on')} aria-pressed={value === m.key} aria-label={m.name ?? m.label} title={m.title} onClick={() => onChange(m.key)}>
            {m.icon && <Icon name={m.icon} size={15} />}
            {m.badge && <kbd className="view-badge">{m.badge}</kbd>}
            <span className="view-label">{m.label}</span>
            {m.sub && <small className="view-sub">{m.sub}</small>}
          </button>
        ))}
      </div>
      {now != null && <div className="view-now">{now}</div>}
      {aside != null && <div className="view-aside">{aside}</div>}
    </div>
  );
}

/** A group of settings with a small title, set apart from the next one. */
export function OptGroup({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return <div className={cx('opt-group', className)} role="group" aria-label={title}><span className="opt-title">{title}</span>{children}</div>;
}
