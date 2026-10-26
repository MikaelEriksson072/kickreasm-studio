const path = require('node:path');

/** Tailwind maps the design tokens from src/styles/tokens.css, so a theme switch changes one place (spec 14.2). */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [path.join(__dirname, 'src/**/*.{ts,tsx,html}')],
  // the ported component stylesheet brings its own base styles
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)', panel: { DEFAULT: 'var(--panel)', 2: 'var(--panel-2)' }, editor: 'var(--editor)',
        line: { DEFAULT: 'var(--line)', 2: 'var(--line-2)' },
        fg: { DEFAULT: 'var(--fg)', 2: 'var(--fg-2)', 3: 'var(--fg-3)' },
        accent: { DEFAULT: 'var(--accent)', hi: 'var(--accent-hi)', ink: 'var(--accent-ink)' },
        ok: 'var(--ok)', warn: 'var(--warn)', err: 'var(--err)', hint: 'var(--hint)',
        kind: {
          code: 'var(--g-code)', gfx: 'var(--g-gfx)', music: 'var(--g-music)', table: 'var(--g-table)',
          text: 'var(--g-text)', basic: 'var(--g-basic)', data: 'var(--g-data)', fill: 'var(--g-fill)',
        },
        syn: {
          mn: 'var(--syn-mn)', ill: 'var(--syn-ill)', dir: 'var(--syn-dir)', label: 'var(--syn-label)', hw: 'var(--syn-hw)',
          kw: 'var(--syn-kw)', num: 'var(--syn-num)', str: 'var(--syn-str)', comment: 'var(--syn-comment)',
        },
      },
      fontFamily: { ui: ['IBM Plex Sans', 'system-ui', 'sans-serif'], code: ['JetBrains Mono', 'monospace'], pixel: ['Silkscreen', 'monospace'] },
    },
  },
  plugins: [],
};
