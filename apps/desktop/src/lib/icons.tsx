import { cx } from './util';

const ICONS = {
  files: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
  blocks: 'M12 3 3 7.5l9 4.5 9-4.5L12 3zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5',
  tag: 'M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9-8-8zM8 8h.01',
  sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  play: 'M7 4.5v15l12-7.5z', check: 'M5 12.5l4.5 4.5L19 7', more: 'M5.5 12a.5.5 0 1 0 0 .01M12 12a.5.5 0 1 0 0 .01M18.5 12a.5.5 0 1 0 0 .01M5 12h1M11.5 12h1M18 12h1',
  download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14', upload: 'M12 20V9M7 13.5l5-5 5 5M5 4h14',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11', redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  search: 'M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0zM20 20l-4.6-4.6',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z', sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  x: 'M6 6l12 12M18 6 6 18', chip: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  doc: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6', code: 'M9 7l-5 5 5 5M15 7l5 5-5 5', list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  warn: 'M12 4 2.5 20h19zM12 10v4.5M12 17.5h.01', info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.5h.01',
  err: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6', ok: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.5 2.5L16 9.5',
  hint: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.8 10.6c.6.5.8 1.2.8 2.4h6c0-1.2.2-1.9.8-2.4A6 6 0 0 0 12 3z',
  prompt: 'M5 7l5 5-5 5M12 17h7', trash: 'M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13', plus: 'M12 5v14M5 12h14',
  menu: 'M4 6h16M4 12h16M4 18h16', panel: 'M4 4h16v16H4zM15 4v16', copy: 'M9 9h11v11H9zM15 9V4H4v11h5',
  left: 'M19 12H5M11 6l-6 6 6 6', right: 'M5 12h14M13 6l6 6-6 6', pencil: 'M4 20h4L19.5 8.5l-4-4L4 16z',
  music: 'M9 18V5.5L20 3.5v12.5M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9h.01', chevron: 'M9 6l6 6-6 6', down: 'M6 9l6 6 6-6', up: 'M6 15l6-6 6 6', target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  folder: 'M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z',
  disk: 'M4 4h13l3 3v13H4zM8 4v5h8V4M8 20v-6h8v6', eject: 'M12 5l7 8H5zM5 18h14',
  bookmark: 'M7 3.5h10v17l-5-3.8-5 3.8z', pack: 'M3.5 4h17v4h-17zM5 8v12h14V8M10 12h4', clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={cx('icon', className)} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export const LVL_ICON: Record<string, IconName> = { info: 'info', ok: 'ok', warn: 'warn', err: 'err', hint: 'hint' };
