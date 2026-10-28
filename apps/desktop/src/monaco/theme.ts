/* Monaco theme built from the CSS design tokens, so the editor follows the light/dark switch. */
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { cssVar } from '../lib/util';

export function applyMonacoTheme(monaco: typeof Monaco, dark: boolean): void {
  const c = (n: string) => cssVar(n).replace('#', '');
  const hx = (n: string) => {
    const v = cssVar(n);
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return v;
    const [r, g, b, a = 1] = m[1].split(',').map(x => parseFloat(x));
    return '#' + [r, g, b, Math.round(a * 255)].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
  };
  monaco.editor.defineTheme('mimir', {
    base: dark ? 'vs-dark' : 'vs', inherit: true,
    rules: [
      { token: 'comment', foreground: c('--syn-comment'), fontStyle: 'italic' },
      { token: 'keyword.mnemonic', foreground: c('--syn-mn') }, { token: 'keyword.illegal', foreground: c('--syn-ill') },
      { token: 'keyword.directive', foreground: c('--syn-dir') }, { token: 'keyword.preproc', foreground: c('--syn-dir') },
      { token: 'keyword.macro', foreground: c('--syn-kw') }, { token: 'variable.member', foreground: c('--syn-kw') },
      { token: 'label.def', foreground: c('--syn-label'), fontStyle: 'bold' }, { token: 'identifier', foreground: c('--syn-label') },
      { token: 'type.hardware', foreground: c('--syn-hw') }, { token: 'number', foreground: c('--syn-num') },
      { token: 'number.hex', foreground: c('--syn-num') }, { token: 'number.binary', foreground: c('--syn-num') },
      { token: 'string', foreground: c('--syn-str') }, { token: 'operator', foreground: c('--fg-2') },
      { token: 'operator.immediate', foreground: c('--syn-num') },
    ],
    colors: {
      'editor.background': hx('--editor'), 'editor.foreground': hx('--fg'), 'editorLineNumber.foreground': hx('--fg-3'),
      'editorLineNumber.activeForeground': hx('--fg-2'), 'editor.lineHighlightBackground': hx('--row-hover'),
      'editor.selectionBackground': hx('--sel-strong'), 'editorGutter.background': hx('--editor'),
      'editorWidget.background': hx('--panel'), 'editorHoverWidget.background': hx('--panel'), 'editorHoverWidget.border': hx('--line'),
      'scrollbarSlider.background': hx('--scroll'), 'minimap.background': hx('--editor'),
    },
  });
  monaco.editor.setTheme('mimir');
}
