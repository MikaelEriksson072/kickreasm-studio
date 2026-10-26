/* The notes document in an exported project: the user's bookmarks (with the code around them) and the comments they
 * wrote. NOTES.html is one self-contained page to read in a browser or print, NOTES.txt the same as plain text
 * (Settings.notesFormat, spec 11.4). Built from the rendered files, so every address, line number and code line is
 * the one in the exported .asm files. */
import type { Addr, Bookmark, Line, Project, RenderResult, Settings, Token } from './types';
import { h2, h4 } from './util/hex';
import { lineText, kickMnemonic, TOP_LEVEL_DIRECTIVES, type LineTextSettings } from './render/lines';

export const NOTES_FILE = 'NOTES.html';
export const NOTES_TEXT_FILE = 'NOTES.txt';

/** the file the export writes for Settings.notesFormat (older settings without it: the page) */
export const notesFile = (S: Pick<Settings, 'notesFormat'>): string | null => (S.notesFormat === 'none' ? null : S.notesFormat === 'txt' ? NOTES_TEXT_FILE : NOTES_FILE);

type NotesProject = Pick<Project, 'name' | 'files'> & Partial<Pick<Project, 'bookmarks' | 'notes' | 'comments' | 'blockComments'>>;

/** where an address is in the exported source: the file, the index of its line in R.fileLines and the line number */
interface Loc { file: string; idx: number; line: number }

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const TOKEN_CLASS: Record<Token['t'], string> = { lbl: 'lb', hw: 'hw', kw: 'kw', num: 'nm', str: 'st', dir: 'dr', def: 'lb', p: '' };

/** A line as lineText() writes it, in spans for the syntax colours (the text is exactly lineText's). */
export function lineHtml(l: Line, S: LineTextSettings): string {
  const parts: [string, string][] = [];
  const toks = (tk: Token[]) => { for (const t of tk) parts.push([TOKEN_CLASS[t.t], t.s]); };
  const ind = ' '.repeat(S.indent);
  const cmt = (c: string | undefined) => {
    if (!c) return;
    const len = parts.reduce((n, [, s]) => n + s.length, 0);
    parts.push(['', ' '.repeat(Math.max(1, S.commentCol - len))], ['cm', '// ' + c]);
  };
  const cc = (c: string) => [l.a != null && S.addrComments && (l.k === 'ins' || l.k === 'dat') ? '$' + h4(l.a) : '', c].filter(Boolean).join('  ');
  switch (l.k) {
    case 'lbl': parts.push(['lb', l.name], ['', ':']); break;
    case 'ins': parts.push(['', ind], [l.ill ? 'il' : 'mn', kickMnemonic(l.mn) + (l.ext || '')]); if (l.tok.length) { parts.push(['', ' ']); toks(l.tok); } cmt(cc(l.cmt)); break;
    case 'dat': parts.push(['', ind], ['dr', l.dir], ['', ' ']); toks(l.tok); cmt(cc(l.cmt)); break;
    case 'dir': if (!(l.tok[0] && TOP_LEVEL_DIRECTIVES.includes(l.tok[0].s))) parts.push(['', ind]); toks(l.tok); cmt(l.cmt); break;
    default: parts.push(['cm', lineText(l, S)]);
  }
  return parts.map(([c, s]) => (c ? `<span class="${c}">${esc(s)}</span>` : esc(s))).join('');
}

/** yyyy-mm-dd hh:mm in local time */
const stamp = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** The user's annotations that are in the exported source, by address. */
function annotations(project: NotesProject, R: RenderResult, at: (a: Addr) => Loc | null) {
  const bookmarks = Object.entries(project.bookmarks || {}).map(([k, b]) => [Number(k), b] as [Addr, Bookmark]).sort((x, y) => x[0] - y[0]);
  const comments: { a: Addr; kind: string; text: string }[] = [];
  const add = (rec: Record<Addr, string> | undefined, kind: string, written: (a: Addr, loc: Loc) => boolean = () => true) => {
    for (const [k, t] of Object.entries(rec || {})) { const a = Number(k), loc = at(a); if (t.trim() && loc && written(a, loc)) comments.push({ a, kind, text: t.trim() }); }
  };
  add(project.blockComments, 'Block comment');
  for (const [k, n] of Object.entries(project.notes || {})) if (n.text.trim() && at(Number(k))) comments.push({ a: Number(k), kind: n.block ? 'Comment block' : 'Comment line', text: n.text.replace(/^(\s*\n)+/, '').trimEnd() });
  // the source only has a comment at the end of a line that starts at its address
  add(project.comments, 'End of line', (a, loc) => { const l = R.fileLines[loc.file][loc.idx]; return (l.k === 'dir' && l.zp != null ? l.zp : l.a) === a && 'userCmt' in l && !!l.userCmt; });
  const order = ['Block comment', 'Comment block', 'Comment line', 'End of line'];
  comments.sort((x, y) => x.a - y.a || order.indexOf(x.kind) - order.indexOf(y.kind));
  return { bookmarks, comments };
}

/** a line of the exported source as both documents show it: its number in the file, address and first bytes */
interface Row { no: number; adr: string; bytes: string; line: Line; cur: boolean }
/** an annotated address: where it is in the source, the label the source gives it and the block it is in */
interface Place { a: Addr; loc: Loc | null; name: string | null; block: string | null }
interface Notes {
  files: string[];
  bookmarks: (Place & { title: string; text: string; rows: Row[] })[];
  comments: (Place & { kind: string; text: string; row: Row })[];
}

/** What both documents show, or null when the project has no bookmarks and no comments in the exported source. */
function collect(project: NotesProject, R: RenderResult, S: Settings): Notes | null {
  const files = R.fileNames.map(n => `${n}.asm`).filter(f => R.fileLines[f]);
  // every byte's line (the first line holding it), else the line of the label at the address
  // and a zero-page variable's address its .label line in the file head
  const byte = new Map<Addr, Loc>(), label = new Map<Addr, Loc>(), zpDef = new Map<Addr, Loc>(), nos: Record<string, number[]> = {};
  for (const file of files) {
    const lines = R.fileLines[file], no: number[] = [];
    let n = 1;
    lines.forEach((l, idx) => {
      no.push(n); n += lineText(l, S).split('\n').length;
      if ('n' in l && l.n > 0) for (let a = l.a; a < l.a + l.n && a < 0x10000; a++) { if (!byte.has(a)) byte.set(a, { file, idx, line: no[idx] }); }
      else if (l.k === 'lbl' && !label.has(l.a)) label.set(l.a, { file, idx, line: no[idx] });
      else if (l.k === 'dir' && l.zp != null && !zpDef.has(l.zp)) zpDef.set(l.zp, { file, idx, line: no[idx] });
    });
    nos[file] = no;
  }
  const at = (a: Addr) => byte.get(a) ?? label.get(a) ?? zpDef.get(a) ?? null;
  const { bookmarks, comments } = annotations(project, R, at);
  if (!bookmarks.length && !comments.length) return null;

  const mem = new Int16Array(0x10000).fill(-1);
  for (const f of project.files) f.bytes.forEach((b, i) => { if (f.load + i < 0x10000) mem[f.load + i] = b; });
  const bytes = (l: Line) => {
    if (!('n' in l) || !l.n) return '';
    const bs = [...Array(Math.min(l.n, 3)).keys()].map(i => mem[l.a + i]).filter(b => b >= 0).map(h2);
    return bs.join(' ') + (l.n > 3 ? ' …' : '');
  };
  /** the label the source gives the address (name+offset inside a block), and the block header above it */
  const context = (loc: Loc, a: Addr) => {
    const lines = R.fileLines[loc.file];
    let name: string | null = null, block: string | null = null;
    for (let i = loc.idx; i >= 0; i--) {
      const l = lines[i];
      if (!name && l.k === 'lbl' && l.a <= a) name = l.a === a ? l.name : `${l.name}+${a - l.a}`;
      if (l.k === 'hdr') { block = l.text; break; }
    }
    return { name: name ?? R.labels.get(a)?.name ?? R.zp.get(a)?.name ?? null, block };
  };
  const row = (loc: Loc, i: number): Row => {
    const l = R.fileLines[loc.file][i];
    return { no: nos[loc.file][i], adr: ('n' in l && l.n > 0) || l.k === 'lbl' ? h4(l.a) : '', bytes: bytes(l), line: l, cur: i === loc.idx };
  };
  /** a few lines around the address: its label and comment lines above it, then up to six lines of its block */
  const excerpt = (loc: Loc) => {
    const lines = R.fileLines[loc.file];
    let s = loc.idx; while (s > 0 && loc.idx - s < 6 && (lines[s - 1].k === 'lbl' || lines[s - 1].k === 'cmt')) s--;
    let e = loc.idx + 1; while (e < lines.length && e - loc.idx < 7 && lines[e].k !== 'hdr' && lines[e].k !== 'blank') e++;
    const rows: Row[] = []; for (let i = s; i < e; i++) rows.push(row(loc, i));
    return rows;
  };
  const place = (a: Addr): Place => { const loc = at(a); return { a, loc, ...(loc ? context(loc, a) : { name: R.labels.get(a)?.name ?? null, block: null }) }; };
  return {
    files,
    bookmarks: bookmarks.map(([a, b]) => { const p = place(a); return { ...p, title: b.title || `$${h4(a)}`, text: b.text.trim(), rows: p.loc ? excerpt(p.loc) : [] }; }),
    comments: comments.map(c => { const p = place(c.a); return { ...p, kind: c.kind, text: c.text, row: { ...row(p.loc!, p.loc!.idx), cur: false } }; }),
  };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * NOTES.html, or null when the project has no bookmarks and no comments in the exported source.
 * `generated` is the time shown in the head (none: no time, so the output only depends on the project).
 */
export function notesDocument(project: NotesProject, R: RenderResult, S: Settings, generated?: Date): string | null {
  const N = collect(project, R, S);
  if (!N) return null;
  const { files, bookmarks, comments } = N;
  const row = (r: Row) => `<div class="r${r.cur ? ' cur' : ''}"><span class="ln">${r.no}</span><span class="ad">${r.adr}</span><span class="by">${r.bytes}</span><span class="sc">${lineHtml(r.line, S) || ' '}</span></div>`;
  const where = (loc: Loc | null) => (loc ? `<span>${esc(loc.file)}, line ${loc.line}</span>` : '<span>not in the exported source</span>');
  const anchor = (a: Addr) => `bm-${h4(a)}`;

  const cards = bookmarks.map(b => `<article class="bm" id="${anchor(b.a)}">
<header><span class="adr">$${h4(b.a)}</span><h3>${esc(b.title)}</h3></header>
<div class="meta">${b.name ? `<span class="mono">${esc(b.name)}</span>` : ''}${b.block ? `<span>${esc(b.block)}</span>` : ''}${where(b.loc)}</div>
${b.text ? `<div class="note">${esc(b.text)}</div>` : '<div class="note empty">No note.</div>'}
${b.loc ? `<div class="code" role="figure" aria-label="${esc(b.loc.file)}, line ${b.loc.line}">${b.rows.map(row).join('')}</div>` : ''}
</article>`).join('\n');
  const marks = new Set(bookmarks.map(b => b.a));
  const items = comments.map(c => `<li class="cm-item">
<div class="meta"><span class="adr">${marks.has(c.a) ? `<a href="#${anchor(c.a)}">$${h4(c.a)}</a>` : `$${h4(c.a)}`}</span>${c.name ? `<span class="mono">${esc(c.name)}</span>` : ''}<span class="tag">${c.kind}</span>${where(c.loc)}</div>
<div class="note">${esc(c.text)}</div>
<div class="code one">${row(c.row)}</div>
</li>`).join('\n');

  const facts = [
    ['Files', project.files.map(f => `${esc(f.name)} <span class="mono">$${h4(f.load)}–$${h4(f.load + f.bytes.length - 1)}</span>`).join('<br>')],
    ['Source', files.map(f => `<span class="mono">${esc(f)}</span>`).join(', ')],
    ...(generated ? [['Exported', stamp(generated)]] : []),
  ];
  const toc = bookmarks.length > 1 ? `<nav class="toc" aria-label="Bookmarks"><ol>${bookmarks.map(b => `<li><a href="#${anchor(b.a)}"><span class="adr">$${h4(b.a)}</span>${esc(b.title)}</a></li>`).join('')}</ol></nav>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="KickReasm Studio">
<title>${esc(project.name)}: bookmarks and comments</title>
<style>
:root { color-scheme: light dark;
  --bg: #f6f5fa; --card: #ffffff; --code: #fbfaff; --line: #e2dfec; --fg: #1d1b2a; --fg-2: #54516a; --fg-3: #87849b; --accent: #5a4ed1; --mark: #b7791f; --cur: rgba(90, 78, 209, 0.11);
  --mn: #2356c4; --il: #c2410c; --dr: #7c3aed; --lb: #946200; --hw: #0d7d71; --kw: #be185d; --nm: #b45309; --st: #3b7a1e; --cm: #8a879f;
  --ui: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif; --mono: "JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root {
  --bg: #121218; --card: #18181f; --code: #14141a; --line: #292935; --fg: #dedde9; --fg-2: #a4a2b9; --fg-3: #6d6b82; --accent: #8b80f9; --mark: #e5a83b; --cur: rgba(139, 128, 249, 0.18);
  --mn: #8cb4ff; --il: #ff9b73; --dr: #c49bff; --lb: #f0c674; --hw: #4fd1c0; --kw: #ff8ccb; --nm: #e4a76a; --st: #9dd28a; --cm: #6f6d88; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 var(--ui); -webkit-font-smoothing: antialiased; }
main { max-width: 920px; margin: 0 auto; padding: 48px 24px 64px; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
.mono, .adr, .code { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.kicker { font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--fg-3); }
h1 { margin: 6px 0 6px; font-size: 34px; line-height: 1.15; letter-spacing: -0.01em; }
.lead { margin: 0 0 22px; color: var(--fg-2); font-size: 16px; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; margin: 0 0 30px; padding: 16px 18px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); font-size: 14px; }
.facts dt { color: var(--fg-3); } .facts dd { margin: 0; }
h2 { margin: 40px 0 6px; font-size: 22px; }
h2 + .sub { margin: 0 0 18px; color: var(--fg-2); font-size: 14px; }
.toc ol { list-style: none; margin: 0 0 8px; padding: 0; columns: 2 260px; column-gap: 24px; }
.toc li { break-inside: avoid; padding: 3px 0; }
.toc a { display: flex; gap: 10px; color: var(--fg); } .toc .adr { color: var(--mark); font-size: 13.5px; }
.bm, .cm-item { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; margin: 0 0 16px; break-inside: avoid; }
.bm { border-left: 4px solid var(--mark); }
.bm header { display: flex; align-items: baseline; gap: 12px; }
.bm h3 { margin: 0; font-size: 19px; }
.bm header .adr { color: var(--mark); font-size: 15px; font-weight: 600; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 6px 0 12px; color: var(--fg-3); font-size: 13px; }
.meta .mono { color: var(--lb); }
.note { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 14px; }
.note.empty { color: var(--fg-3); font-style: italic; }
.code { background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 8px 0; font-size: 12.5px; line-height: 20px; overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
.code .r { display: grid; grid-template-columns: 4.5ch 5ch 10ch auto; gap: 0 12px; padding: 0 14px; white-space: pre; min-width: max-content; }
.code .r.cur { background: var(--cur); box-shadow: inset 3px 0 0 var(--mark); }
.code .ln { color: var(--fg-3); text-align: right; opacity: 0.7; } .code .ad, .code .by { color: var(--fg-3); }
.code.one { padding: 4px 0; margin: 0; }
.cm-list { list-style: none; margin: 0; padding: 0; }
.cm-item { padding: 14px 18px; } .cm-item .meta { margin-top: 0; } .cm-item .note { margin-bottom: 10px; }
.cm-item .meta .adr { color: var(--fg); font-weight: 600; }
.tag { padding: 0 8px; border-radius: 99px; border: 1px solid var(--line); color: var(--fg-2); font-size: 12px; }
.mn { color: var(--mn); } .il { color: var(--il); } .dr { color: var(--dr); } .lb { color: var(--lb); } .hw { color: var(--hw); } .kw { color: var(--kw); } .nm { color: var(--nm); } .st { color: var(--st); } .cm { color: var(--cm); }
footer { margin-top: 44px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--fg-3); font-size: 13px; }
@media (max-width: 600px) { main { padding: 28px 16px 48px; } h1 { font-size: 27px; } .facts { grid-template-columns: 1fr; gap: 2px; } .facts dd { margin-bottom: 8px; } .bm, .cm-item { padding: 14px; } .code .r { grid-template-columns: 4ch 4ch auto; gap: 0 10px; padding: 0 10px; } .code .by { display: none; } }
@media print { :root { color-scheme: light; } body { background: #fff; font-size: 11pt; } main { max-width: none; padding: 0; } .bm, .cm-item, .facts { border-color: #ccc; } a { color: inherit; } .code { overflow: visible; } .code .r { min-width: 0; white-space: pre-wrap; } }
</style>
</head>
<body>
<main>
<header>
<div class="kicker">KickReasm Studio · project notes</div>
<h1>${esc(project.name)}</h1>
<p class="lead">${count(bookmarks.length, 'bookmark', 'bookmarks')} and ${count(comments.length, 'comment', 'comments')} in the re-assembled source.</p>
<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
</header>
${bookmarks.length ? `<section id="bookmarks">
<h2>Bookmarks</h2>
<p class="sub">Your notes on addresses, by address, each with the code around it. Line numbers are those of the exported files.</p>
${toc}
${cards}
</section>` : ''}
${comments.length ? `<section id="comments">
<h2>Comments in the source</h2>
<p class="sub">The comments you wrote: they are in the .asm files too, as // lines, /* */ blocks and comments at the end of a line.</p>
<ol class="cm-list">
${items}
</ol>
</section>` : ''}
<footer>Generated by KickReasm Studio. The bookmarks are kept in <span class="mono">${esc(project.name)}.krproj.json</span> and are not part of the source.</footer>
</main>
</body>
</html>
`;
}

/** NOTES.txt: what NOTES.html shows, as plain text (Settings.notesFormat 'txt'); null as for notesDocument. */
export function notesText(project: NotesProject, R: RenderResult, S: Settings, generated?: Date): string | null {
  const N = collect(project, R, S);
  if (!N) return null;
  const { files, bookmarks, comments } = N;
  const title = `${project.name}: bookmarks and comments`;
  const out = [title, '='.repeat(title.length), '', 'KickReasm Studio · project notes', ''];
  const fact = (k: string, v: string[]) => v.forEach((x, i) => out.push(`${i ? '' : k + ':'}`.padEnd(11) + x));
  fact('Files', project.files.map(f => `${f.name}  $${h4(f.load)}-$${h4(f.load + f.bytes.length - 1)}`));
  fact('Source', [files.join(', ')]);
  if (generated) fact('Exported', [stamp(generated)]);
  out.push('', `${count(bookmarks.length, 'bookmark', 'bookmarks')} and ${count(comments.length, 'comment', 'comments')} in the re-assembled source.`);
  const indent = (s: string) => s.split('\n').map(l => (l.trim() ? '  ' + l : '')).join('\n');
  const width = Math.max(4, ...bookmarks.flatMap(b => b.rows.map(r => String(r.no).length)), ...comments.map(c => String(c.row.no).length));
  // ">" marks the bookmarked line, as the highlighted line does in NOTES.html
  const row = (r: Row) => `  ${r.cur ? '>' : ' '} ${String(r.no).padStart(width)}  ${r.adr.padEnd(4)}  ${r.bytes.padEnd(10)}  ${lineText(r.line, S)}`.trimEnd();
  // a comment names its kind instead of the block, as in NOTES.html
  const meta = (p: Place, kind?: string) => '  ' + [p.name, kind ?? p.block, p.loc ? `${p.loc.file}, line ${p.loc.line}` : 'not in the exported source'].filter(Boolean).join(' · ');
  const heading = (t: string) => out.push('', '', t, '-'.repeat(t.length));
  if (bookmarks.length) {
    heading(`BOOKMARKS (${bookmarks.length})`);
    if (bookmarks.length > 1) out.push('', ...bookmarks.map(b => `  $${h4(b.a)}  ${b.title}`));
    for (const b of bookmarks) {
      out.push('', '', `$${h4(b.a)}  ${b.title}`, meta(b), '', b.text ? indent(b.text) : '  (no note)');
      if (b.rows.length) out.push('', ...b.rows.map(row));
    }
  }
  if (comments.length) {
    heading(`COMMENTS IN THE SOURCE (${comments.length})`);
    for (const c of comments) out.push('', `$${h4(c.a)}${meta(c, c.kind)}`, indent(c.text), row(c.row));
  }
  out.push('', '', `Generated by KickReasm Studio. The bookmarks are kept in ${project.name}.krproj.json and are not part of the source.`, '');
  return out.join('\n');
}

/** The notes document the export writes for Settings.notesFormat, as [file name, content], or null when there is none. */
export function notesExport(project: NotesProject, R: RenderResult, S: Settings, generated?: Date): [string, string] | null {
  const file = notesFile(S);
  const doc = file === NOTES_TEXT_FILE ? notesText(project, R, S, generated) : file ? notesDocument(project, R, S, generated) : null;
  return file && doc ? [file, doc] : null;
}

/** the notes file the export writes, without building it (null: none) */
export const notesFor = (project: NotesProject, R: RenderResult, S: Settings): string | null => {
  const file = notesFile(S);
  return file && collect(project, R, S) ? file : null;
};
