import { Icon, type IconName } from '../lib/icons';
import { cx } from '../lib/util';
import type { Activity } from '../store/ui';

const ITEMS: [Activity, IconName, string][] = [['explorer', 'files', 'Explorer'], ['blocks', 'blocks', 'Blocks'], ['symbols', 'tag', 'Symbols'], ['bookmarks', 'bookmark', 'Bookmarks (Ctrl+B)'], ['pack', 'pack', 'Pack (Brokkr or Exomizer)']];

export function ActivityBar({ activity, specOpen, counts = {}, busy = {}, onActivity, onSpec, onPalette }: {
  activity: Activity; specOpen: boolean;
  /** a number shown on a view's button (the bookmarks, the ranges to pack) */
  counts?: Partial<Record<Activity, number>>;
  /** views at work (Pack while it packs): a spinner on the button instead of the number */
  busy?: Partial<Record<Activity, boolean>>;
  onActivity: (a: Activity) => void; onSpec: () => void; onPalette: () => void;
}) {
  return (
    <nav className="activity" aria-label="Views">
      {ITEMS.map(([k, ic, l]) => (
        <button key={k} className={cx(activity === k && 'on', busy[k] && 'busy')} title={busy[k] ? `${l}: packing…` : l} aria-label={l.replace(/ \(.*\)$/, '')} aria-pressed={activity === k} aria-busy={busy[k] || undefined} onClick={() => onActivity(k)}>
          <Icon name={ic} size={20} />{busy[k] ? <span className="act-busy spinner" aria-hidden /> : counts[k] ? <span className="act-count">{counts[k]}</span> : null}
        </button>
      ))}
      <span className="grow" />
      <button title="Technical specification" aria-label="Technical specification" className={cx(specOpen && 'on')} onClick={onSpec}><Icon name="doc" size={20} /></button>
      <button title="Command palette (Ctrl+Shift+P)" aria-label="Command palette" onClick={onPalette}><Icon name="prompt" size={20} /></button>
    </nav>
  );
}
