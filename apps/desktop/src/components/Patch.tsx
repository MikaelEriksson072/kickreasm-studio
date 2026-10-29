/* Patch (spec 10.2): new code written over a range of the loaded bytes. The code is Kick Assembler, assembled at the
 * range's start as it is typed, with the program's labels, zero-page variables and the hardware symbols at hand. The
 * editor shows each line's address and bytes beside it, as an assembler listing does; the cursor starts on the first
 * instruction, Tab and Shift+Tab go to the next and the previous one, and Enter keeps the indent. The code may not be
 * longer than the range unless "Overwrite past the range" is ticked; a shorter one leaves the rest to the fill.
 * Nothing changes until "Apply patch", and Ctrl+Z takes it back. */
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { h2, h4, patchEnd, planPatch, type Addr, type AnalysisResult, type PatchFill, type PatchLine, type PatchPlan, type Project, type RenderResult } from '@mimir/core';
import { cx } from '../lib/util';
import { Modal } from './Modal';

/** what the dialog starts with: the range, and the code (the listing's lines, or the patch being edited) */
export interface PatchDraft { start: Addr; end: Addr; name: string; source: string; fill: PatchFill; over: boolean; id?: string }

interface PatchModalProps {
  A: AnalysisResult; R: RenderResult; project: Project; draft: PatchDraft;
  onApply: (plan: PatchPlan) => void;
  onClose: () => void;
}

const SHOWN = 24;
const hex = (b: Uint8Array) => [...b.subarray(0, SHOWN)].map(h2).join(' ') + (b.length > SHOWN ? ' …' : '');

/** where the instruction (or directive) on a line starts, after a label and the indent; null: none (a label alone,
 *  a comment, an empty line) */
export function instructionAt(line: string): number | null {
  const code = line.replace(/\/\/.*$/, '').replace(/\s+$/, '');
  const label = /^\s*[A-Za-z_]\w*:/.exec(code);
  const from = label ? label[0].length : 0;
  const m = /\S/.exec(code.slice(from));
  return m ? from + m.index : null;
}
const labelOnly = (line: string) => /^\s*[A-Za-z_]\w*:\s*(\/\/.*)?$/.test(line);

export function PatchModal({ A, R, project, draft, onApply, onClose }: PatchModalProps) {
  const [name, setName] = useState(draft.name);
  const [source, setSource] = useState(draft.source);
  const [fill, setFill] = useState<PatchFill>(draft.fill);
  const [over, setOver] = useState(draft.over);
  const { start, end } = draft, size = end - start;
  const plan = useMemo(() => planPatch(A, R, project, { name, start, end, source, fill, over, id: draft.id }), [A, R, project, name, start, end, source, fill, over, draft.id]);
  const ok = !('error' in plan);
  const apply = () => { if (ok) onApply(plan); };
  const keys = (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); } };
  const span = (a: Addr, b: Addr) => (b - a > 1 ? `$${h4(a)}–$${h4(b - 1)}` : `$${h4(a)}`);

  let sum = null;
  if (ok) {
    const { patch, code, past } = plan, n = code.length, rest = size - Math.min(n, size);
    sum = <div className="patch-sum small" role="status">
      <p><b>{n} of {size} bytes</b>{rest > 0 && (fill === 'nop' ? `; the other ${rest} become NOP ($ea)` : `; the other ${rest} stay as they are`)}
        {past > 0 && <>; <span className="warn-text">{past} byte{past === 1 ? '' : 's'} past the range, over {span(end, patchEnd(patch))}</span></>}.</p>
      <div className="patch-bytes mono"><span className="muted">writes</span><span>{hex(patch.bytes)}</span><span className="muted">over</span><span>{hex(patch.old)}</span></div>
    </div>;
  }
  return (
    <Modal title={draft.id ? `Edit patch "${draft.name}"` : `Patch ${span(start, end)}`} onClose={onClose} className="patch-modal">
      <div className="modal-body patch" onKeyDown={keys}>
        <div className="grid2">
          <label className="field"><span>Name</span><input id="patch-name" value={name} spellCheck={false} maxLength={64} onChange={e => setName(e.target.value)} /></label>
          <label className="field"><span>Fill the rest with</span>
            <select id="patch-fill" value={fill} onChange={e => setFill(e.target.value as PatchFill)}><option value="nop">NOP ($ea)</option><option value="keep">the bytes that are there</option></select></label>
        </div>
        <PatchEditor value={source} onChange={setSource} start={start} end={end} lines={plan.lines} code={plan.code} errorLine={'error' in plan ? plan.line : undefined} original={!draft.id} />
        <label className="check small"><input type="checkbox" id="patch-over" checked={over} onChange={e => setOver(e.target.checked)} />
          <span>Overwrite past the range: the code may be longer than the {size} bytes, and writes over the bytes after it</span></label>
        {ok ? sum : <div className="err-text small" role="alert">{plan.error}</div>}
        <p className="muted small">The patch is written over the loaded bytes, and the listing marks them. Explorer → Patches switches it off and on and saves it as a PRG; the export writes its source to patches/ (.asm, which assembles on its own). Ctrl+Z takes it back.</p>
      </div>
      <div className="modal-foot"><span className="grow" /><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!ok} onClick={apply} title="Ctrl+Enter">{draft.id ? 'Save patch' : 'Apply patch'}</button></div>
    </Modal>
  );
}

interface PatchEditorProps {
  value: string; onChange: (v: string) => void;
  /** the range: lines whose bytes go past its end are marked */
  start: Addr; end: Addr;
  /** each line's address and length, and the code's bytes from `start`, as far as the assembler got */
  lines?: (PatchLine | null)[]; code?: Uint8Array;
  /** the line the error is on (1 for the first) */
  errorLine?: number;
  /** the code starts as the original's lines (a new patch): what is written over them moves them to the right */
  original?: boolean;
}

/** The lines of `next` that are the lines of `prev` they came from, given what changed between them (the same lines
 *  at the start and at the end): a line edited, split or joined keeps what its first part had, a new line has none. */
function followLines<T>(prev: readonly string[], next: readonly string[], per: readonly (T | null)[]): (T | null)[] {
  let p = 0;
  while (p < prev.length && p < next.length && prev[p] === next[p]) p++;
  let s = 0;
  while (s < prev.length - p && s < next.length - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  const was = prev.length - p - s;
  return [...per.slice(0, p), ...Array.from({ length: next.length - p - s }, (_, k) => (k < was ? per[p + k] ?? null : null)), ...per.slice(prev.length - s)];
}

/** an original line's instruction as the Original column shows it (without the indent and the comment) */
const bare = (line: string) => line.replace(/\/\/.*$/, '').trim();

/**
 * The code with an assembler listing's columns beside it: each line's address and its first bytes. In a new patch
 * the lines start as the original's; typing at the start of an original instruction writes over all of it, editing
 * one changes it, and either way the original moves to the Original column on the right, out of the code.
 */
function PatchEditor({ value, onChange, start, end, lines, code, errorLine, original }: PatchEditorProps) {
  const ta = useRef<HTMLTextAreaElement>(null), gut = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(0);
  const [top, setTop] = useState(0);
  const text = value.split('\n');
  /** per line: the original line it still is or was edited from (null: a line of the user's) */
  const origin = useRef<(string | null)[]>(original ? text.map(l => (instructionAt(l) != null ? l : null)) : text.map(() => null));
  const change = (next: string) => { origin.current = followLines(text, next.split('\n'), origin.current); onChange(next); };
  const moved = text.map((l, i) => { const o = origin.current[i]; return o != null && l !== o ? bare(o) : null; });
  const anyMoved = moved.some(Boolean);
  /** where each line starts in the text */
  const offsets = useMemo(() => { const o = [0]; for (const l of value.split('\n')) o.push(o[o.length - 1] + l.length + 1); return o; }, [value]);
  const lineAt = (pos: number) => { let i = 0; while (i + 1 < offsets.length - 1 && offsets[i + 1] <= pos) i++; return i; };
  // a new line is indented like the code's instructions
  const indent = (() => { for (const l of text) if (instructionAt(l) != null && !/^\s*[A-Za-z_]\w*:/.test(l)) return /^\s*/.exec(l)![0]; return '        '; })();
  const lineH = () => { const el = ta.current; return el ? parseFloat(getComputedStyle(el).lineHeight) || 20 : 20; };
  const show = (i: number) => {
    const el = ta.current; if (!el) return;
    const h = lineH(), y = i * h;
    if (y < el.scrollTop) el.scrollTop = y; else if (y + h > el.scrollTop + el.clientHeight - 12) el.scrollTop = y + h - el.clientHeight + 12;
  };
  const caretTo = (i: number) => {
    const el = ta.current; if (!el) return;
    const pos = offsets[i] + (instructionAt(text[i]) ?? 0);
    el.setSelectionRange(pos, pos); setCur(i); show(i);
  };
  // the cursor starts on the first instruction
  useLayoutEffect(() => {
    const el = ta.current; if (!el) return;
    el.focus();
    caretTo(Math.max(0, text.findIndex(l => instructionAt(l) != null)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const instructions = () => text.flatMap((l, i) => (instructionAt(l) != null ? [i] : []));
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget, pos = el.selectionStart;
    if (e.key.length === 1 && e.key.trim() && !e.ctrlKey && !e.metaKey && !e.altKey && pos === el.selectionEnd) {
      // typing at the start of an original instruction writes over it, to the end of the line (one step for Ctrl+Z)
      const i = lineAt(pos), at = instructionAt(text[i]);
      if (origin.current[i] != null && text[i] === origin.current[i] && at != null && pos === offsets[i] + at) {
        e.preventDefault();
        el.setSelectionRange(pos, offsets[i] + text[i].length);
        if (!document.execCommand('insertText', false, e.key)) { el.setRangeText(e.key, pos, offsets[i] + text[i].length, 'end'); change(el.value); }
        return;
      }
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // the next (Shift: the previous) instruction, round to the first (the last)
      e.preventDefault();
      const ins = instructions(); if (!ins.length) return;
      const at = lineAt(e.currentTarget.selectionStart);
      caretTo(e.shiftKey ? ([...ins].reverse().find(i => i < at) ?? ins[ins.length - 1]) : (ins.find(i => i > at) ?? ins[0]));
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      // a new line at the instructions' indent (as typed: Ctrl+Z in the editor takes it back)
      e.preventDefault();
      const l = text[lineAt(pos)];
      const lead = instructionAt(l) != null && !/^\s*[A-Za-z_]\w*:/.test(l) ? /^\s*/.exec(l)![0] : indent;
      if (!document.execCommand('insertText', false, '\n' + lead)) el.setRangeText('\n' + lead, el.selectionStart, el.selectionEnd, 'end');
    }
  };
  const sync = () => { const el = ta.current; if (el) setCur(lineAt(el.selectionStart)); };
  const bytesOf = (ln: PatchLine) => {
    if (!code || ln.len <= 0) return '';
    const b = code.subarray(ln.addr - start, ln.addr - start + Math.min(ln.len, 3));
    return [...b].map(h2).join(' ') + (ln.len > 3 ? ' …' : '');
  };
  return (
    <div className="pe">
      <div className="pe-head small"><span className="pe-adr">Addr</span><span className="pe-hex">Bytes</span><span className="pe-title">Code at ${h4(start)}</span>
        <span className="pe-keys muted"><kbd>Tab</kbd> next instruction · <kbd>Shift</kbd>+<kbd>Tab</kbd> previous · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> apply</span>
        {anyMoved && <span className="pe-was-title" title="The original instructions you have written over: not part of the code">Original</span>}</div>
      <div className="pe-body">
        <div className="pe-gutter mono" ref={gut} aria-hidden="true">
          <div style={{ transform: `translateY(${-top}px)` }}>
            {text.map((l, i) => {
              const ln = lines?.[i] ?? null, hasCode = !!ln && ln.len > 0;
              return <div key={i} className={cx('pe-gl', i === cur && 'cur', errorLine === i + 1 && 'err', hasCode && ln!.addr + ln!.len > end && 'past')}>
                <span className="pe-adr">{ln && (hasCode || labelOnly(l)) ? h4(ln.addr) : ''}</span><span className="pe-hex">{hasCode ? bytesOf(ln!) : ''}</span>
              </div>;
            })}
          </div>
        </div>
        <div className="pe-code">
          <div className="pe-band" style={{ transform: `translateY(${cur * 20 - top}px)` }} />
          {errorLine != null && errorLine <= text.length && <div className="pe-band err" style={{ transform: `translateY(${(errorLine - 1) * 20 - top}px)` }} />}
          <textarea id="patch-code" ref={ta} className="mono" value={value} spellCheck={false} wrap="off" aria-label={`Code at $${h4(start)} (Kick Assembler)`}
            onChange={e => change(e.target.value)} onKeyDown={onKeyDown} onSelect={sync} onKeyUp={sync} onClick={sync}
            onScroll={e => setTop(e.currentTarget.scrollTop)} />
        </div>
        {anyMoved && <div className="pe-was mono" aria-label="Original instructions written over">
          <div style={{ transform: `translateY(${-top}px)` }}>
            {text.map((_, i) => <div key={i} className={cx('pe-wl', i === cur && 'cur')} title={moved[i] ?? undefined}>{moved[i] ?? ''}</div>)}
          </div>
        </div>}
      </div>
    </div>
  );
}
