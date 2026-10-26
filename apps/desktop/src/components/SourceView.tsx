/* Source view — Monaco (bundled locally) with the Kick Assembler language; cursor sync with the
 * listing through the shared line model; Kick Assembler errors as markers. The build scripts can be edited: the
 * project keeps the user's version and the export writes it. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { BUILD_SCRIPTS, lineText, type Addr, type AnalysisResult, type BuildScript, type KickProblem, type RenderResult, type Settings, type Vfs } from '@kickreasm/core';
import { Icon } from '../lib/icons';
import type { NavOptions } from '../lib/types';
import { LineBody } from './Listing';

type MonacoNs = typeof Monaco;

interface SourceViewProps {
  R: RenderResult; A: AnalysisResult; S: Settings; path: string; setPath: (p: string) => void; cursor: Addr | null;
  onNavigate: (a: Addr, o?: NavOptions) => void; theme: string; extraFiles: Vfs; problems: KickProblem[];
  onCopy: (text: string | undefined) => void; onExport: () => void;
  /** the build scripts the user edited (Project.scripts), and how an edit (null: back to generated) is kept */
  scripts: Partial<Record<BuildScript, string>>; onEditScript: (path: BuildScript, text: string | null) => void;
}

const isScript = (p: string): p is BuildScript => (BUILD_SCRIPTS as readonly string[]).includes(p);

const languageOf = (p: string) => p.endsWith('.asm') ? 'kickass' : p.endsWith('.md') ? 'markdown' : p.endsWith('.sh') ? 'shell' : p.endsWith('.bat') ? 'bat' : 'plaintext';

export function SourceView({ R, A, S, path, setPath, cursor, onNavigate, theme, extraFiles, problems, onCopy, onExport, scripts, onEditScript }: SourceViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<MonacoNs | null>(null);
  const ed = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const deco = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const models = useRef<Record<string, Monaco.editor.ITextModel>>({});
  const edPath = useRef<string>('');
  const [state, setState] = useState<'loading' | 'ready' | 'fallback'>('loading');
  const [err, setErr] = useState('');
  const textFiles = useMemo(() => {
    const all: Vfs = { ...R.files, ...extraFiles };
    return Object.keys(all).filter(k => typeof all[k] === 'string').sort((a, b) => (a.endsWith('.asm') ? 0 : 1) - (b.endsWith('.asm') ? 0 : 1) || a.localeCompare(b)).map(k => ({ path: k, text: all[k] as string }));
  }, [R, extraFiles]);
  const cur = textFiles.find(f => f.path === path) || textFiles[0];
  const suppress = useRef(false);
  const onNavigateRef = useRef(onNavigate); onNavigateRef.current = onNavigate;
  const rRef = useRef(R); rRef.current = R;
  // typing in a build script is kept in the project a moment after the last key, and at once on leaving the file
  const onEditRef = useRef(onEditScript); onEditRef.current = onEditScript;
  const pending = useRef<{ path: BuildScript; timer: ReturnType<typeof setTimeout> } | null>(null);
  const applying = useRef(false);
  const flush = () => {
    const p = pending.current; if (!p) return;
    clearTimeout(p.timer); pending.current = null;
    const m = models.current[p.path]; if (m) onEditRef.current(p.path, m.getValue());
  };

  useEffect(() => {
    let alive = true;
    import('../monaco/setup').then(async ({ monaco }) => {
      if (!alive || !host.current) return;
      const { applyMonacoTheme } = await import('../monaco/theme');
      monacoRef.current = monaco;
      applyMonacoTheme(monaco, document.documentElement.dataset.theme !== 'light');
      const editor = monaco.editor.create(host.current, {
        value: '', language: 'kickass', theme: 'kickreasm', readOnly: true, automaticLayout: true, fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
        fontSize: 13, lineHeight: 20, minimap: { enabled: true, scale: 1, renderCharacters: false }, scrollBeyondLastLine: false, renderLineHighlight: 'all',
        smoothScrolling: true, padding: { top: 8 }, guides: { indentation: false }, stickyScroll: { enabled: false }, mouseWheelZoom: true,
      });
      ed.current = editor;
      deco.current = editor.createDecorationsCollection();
      editor.onDidChangeCursorPosition(ev => {
        if (suppress.current || ev.source === 'api') return;
        const lines = rRef.current.fileLines[edPath.current];
        const l = lines && lines[ev.position.lineNumber - 1];
        if (l && l.a != null && (('n' in l && l.n > 0) || l.k === 'lbl')) onNavigateRef.current(l.a, { fromSource: true });
      });
      editor.onDidChangeModelContent(() => {
        const p = edPath.current;
        if (applying.current || !isScript(p)) return;
        if (pending.current) clearTimeout(pending.current.timer);
        pending.current = { path: p, timer: setTimeout(flush, 400) };
      });
      if (document.fonts?.ready) void document.fonts.ready.then(() => monaco.editor.remeasureFonts());
      setState('ready');
    }).catch(e => { if (alive) { setErr(String((e as Error)?.message || e)); setState('fallback'); } });
    return () => { alive = false; flush(); ed.current?.dispose(); Object.values(models.current).forEach(m => m.dispose()); models.current = {}; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const monaco = monacoRef.current;
    if (state === 'ready' && monaco) void import('../monaco/theme').then(({ applyMonacoTheme }) => applyMonacoTheme(monaco, theme !== 'light'));
  }, [theme, state]);

  useEffect(() => {
    void import('../monaco/providers').then(({ monacoContext }) => { monacoContext.R = R; monacoContext.A = A; });
  }, [R, A]);

  useEffect(() => {
    const monaco = monacoRef.current, e = ed.current;
    if (state !== 'ready' || !cur || !monaco || !e) return;
    if (pending.current && pending.current.path !== cur.path) flush();
    let m = models.current[cur.path];
    if (!m) { m = monaco.editor.createModel(cur.text, languageOf(cur.path), monaco.Uri.parse('file:///' + cur.path)); models.current[cur.path] = m; }
    else if (m.getValue() !== cur.text && pending.current?.path !== cur.path) {
      // a change from outside (settings, undo, Restore generated): not an edit of the user's
      const vs = e.saveViewState(); applying.current = true; m.setValue(cur.text); applying.current = false; if (e.getModel() === m && vs) e.restoreViewState(vs);
    }
    if (e.getModel() !== m) e.setModel(m);
    edPath.current = cur.path;
    e.updateOptions({ readOnly: !isScript(cur.path) });
  }, [state, cur?.path, cur?.text]); // eslint-disable-line react-hooks/exhaustive-deps

  // Kick Assembler errors as editor markers
  useEffect(() => {
    const monaco = monacoRef.current;
    if (state !== 'ready' || !monaco) return;
    for (const [p, m] of Object.entries(models.current)) {
      monaco.editor.setModelMarkers(m, 'kickass', problems.filter(pr => pr.file === p && pr.line > 0).map(pr => ({
        severity: pr.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        message: `Kick Assembler: ${pr.message}`, startLineNumber: pr.line, startColumn: Math.max(1, pr.column), endLineNumber: pr.line, endColumn: m.getLineMaxColumn(Math.min(pr.line, m.getLineCount())),
      })));
    }
  }, [problems, state, cur?.path, cur?.text]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const monaco = monacoRef.current, e = ed.current;
    if (state !== 'ready' || !cur || cursor == null || !monaco || !e) return;
    const lines = R.fileLines[cur.path]; if (!lines) return;
    const idx = lines.findIndex(l => 'n' in l && l.n > 0 && cursor >= l.a && cursor < l.a + l.n);
    if (idx < 0) return;
    deco.current?.set([{ range: new monaco.Range(idx + 1, 1, idx + 1, 1), options: { isWholeLine: true, className: 'mon-cur', linesDecorationsClassName: 'mon-cur-gut' } }]);
    suppress.current = true; e.revealLineInCenterIfOutsideViewport(idx + 1); suppress.current = false;
  }, [state, cursor, cur?.path, R]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="source">
      <div className="toolbar">
        <label htmlFor="src-file" className="sr-only">File</label>
        <select id="src-file" value={cur ? cur.path : ''} onChange={e => setPath(e.target.value)}>{textFiles.map(f => <option key={f.path} value={f.path}>{f.path}</option>)}</select>
        <span className="tb-note">{state === 'loading' ? 'Loading Monaco editor…' : state !== 'ready' ? 'Built-in viewer'
          : cur && isScript(cur.path) ? (scripts[cur.path] != null ? 'Edited by you · kept in the project · the export writes this version' : 'Editable · the export writes your version once you change it')
            : 'Monaco · Kick Assembler syntax · read-only (edit labels, comments and types in the listing)'}</span>
        <span className="grow" />
        {cur && isScript(cur.path) && scripts[cur.path] != null && <button className="btn" title="Throw away your edits: the export writes the generated script, which follows the toolchain settings, again" onClick={() => { if (pending.current) { clearTimeout(pending.current.timer); pending.current = null; } onEditScript(cur.path as BuildScript, null); }}><Icon name="undo" />Restore generated</button>}
        <button className="btn" onClick={() => onCopy(cur?.text)}><Icon name="copy" />Copy file</button>
        <button className="btn primary" onClick={onExport}><Icon name="folder" />Export…</button>
      </div>
      {state === 'fallback' && <div className="notice">Monaco could not load ({err}). Showing the built-in highlighter instead; the generated code is identical.</div>}
      <div className="mon-host" ref={host} style={{ display: state === 'ready' ? 'block' : 'none' }} />
      {state !== 'ready' && cur && <FallbackCode path={cur.path} R={R} text={cur.text} S={S} />}
    </div>
  );
}

function FallbackCode({ path, R, text, S }: { path: string; R: RenderResult; text: string; S: Settings }) {
  const lines = R.fileLines[path];
  if (!lines) return <pre className="fallback-code">{text}</pre>;
  return (
    <div className="fallback-code">
      {lines.map((l, i) => (
        <div key={i} className="fc-line"><span className="fc-no">{i + 1}</span><span className="fc-src">{l.k === 'hdr' ? <span className="syn-comment">{lineText(l, S)}</span> : <LineBody l={l} onToken={() => { }} />}</span></div>
      ))}
    </div>
  );
}
