import { describe, expect, it } from 'vitest';
import { analyze, DEFAULT_SETTINGS, demoProject, exportFiles, lineHtml, lineText, NOTES_FILE, NOTES_TEXT_FILE, notesDocument, notesText, render, type Line, type Project, type Settings } from '../src';
import { SETTING_VARIANTS } from './helpers/programs';

const build = (p: Project, S: Settings = { ...DEFAULT_SETTINGS, ...p.settings }) => { const R = render(analyze(p), p); return { R, S }; };
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** the 1-based line of the exported file whose text starts (after the indent) with `start` */
const lineOf = (src: string, start: string) => src.split('\n').findIndex(l => l.trimStart().startsWith(start)) + 1;

const annotated = (): Project => ({
  ...demoProject(),
  bookmarks: {
    0x0810: { title: 'Set up', text: 'clears the screen\nthen starts the <raster> IRQ & music' },
    0x09b5: { title: 'sine table', text: '' },
    0x9000: { title: 'not loaded', text: 'the file with this was removed' },
  },
  notes: { 0x0813: { text: 'set up the irq' }, 0x09b5: { text: 'curve for the\nsprite x position', block: true } },
  comments: { 0x0816: 'no interrupts while we set up', 0x0818: 'not at a line start? kept anyway' },
  blockComments: { 0x0810: 'entry from the BASIC stub' },
});

describe('NOTES.html', () => {
  it('colours a line without changing its text', () => {
    for (const S of [DEFAULT_SETTINGS, ...SETTING_VARIANTS.map(v => ({ ...DEFAULT_SETTINGS, ...v }))]) {
      const p = { ...annotated(), settings: S };
      const { R } = build(p, S);
      for (const lines of Object.values(R.fileLines)) for (const l of lines as Line[]) expect(text(lineHtml(l, S))).toBe(lineText(l, S));
    }
  });

  it('is not written for a project without bookmarks and comments', () => {
    const p = demoProject(), { R, S } = build(p);
    expect(notesDocument(p, R, S)).toBeNull();
    const out = exportFiles(p, R, S);
    expect(out[NOTES_FILE]).toBeUndefined();
    expect(out['README.md']).not.toContain(NOTES_FILE);
  });

  it('lists the bookmarks by address with their label, block, file line and the code around them', () => {
    const p = annotated(), { R, S } = build(p);
    const doc = notesDocument(p, R, S)!;
    const src = R.files['raster-demo.asm'] as string;
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<title>raster-demo: bookmarks and comments</title>');
    expect(doc).toContain('3 bookmarks and 4 comments in the re-assembled source.');
    // by address, in the table of contents and as cards
    const cards = [...doc.matchAll(/<article class="bm" id="bm-([0-9a-f]{4})">/g)].map(m => m[1]);
    expect(cards).toEqual(['0810', '09b5', '9000']);
    expect(doc).toContain('<a href="#bm-0810"><span class="adr">$0810</span>Set up</a>');
    // the note is escaped and keeps its line breaks
    expect(doc).toContain('<div class="note">clears the screen\nthen starts the &lt;raster&gt; IRQ &amp; music</div>');
    expect(doc).not.toContain('<raster>');
    expect(doc).toContain('<div class="note empty">No note.</div>');
    const card = (a: string) => doc.slice(doc.indexOf(`id="bm-${a}"`), doc.indexOf('</article>', doc.indexOf(`id="bm-${a}"`)));
    const set = card('0810');
    expect(set).toContain('<span class="mono">start</span>');
    expect(set).toContain('Code · start · $0810');
    expect(set).toContain(`raster-demo.asm, line ${lineOf(src, 'jsr CLRSCR')}`);
    // the excerpt: the comment lines and label above, the bookmarked line marked, the lines after it
    const rows = [...set.matchAll(/<div class="r( cur)?"><span class="ln">(\d+)<\/span><span class="ad">([0-9a-f]*)<\/span><span class="by">([^<]*)<\/span><span class="sc">(.*?)<\/span><\/div>/g)];
    const cur = rows.find(r => r[1])!;
    expect(cur[2]).toBe(String(lineOf(src, 'jsr CLRSCR')));
    expect([cur[3], cur[4], text(cur[5]).trim()]).toEqual(['0810', '20 44 e5', 'jsr CLRSCR                      // Clear screen and home cursor']);
    expect(cur[5]).toContain('<span class="mn">jsr</span> <span class="hw">CLRSCR</span>');
    expect(rows.map(r => text(r[5]).trim())).toContain('start:');
    expect(rows.map(r => Number(r[2]))).toEqual(rows.map((r, i) => Number(rows[0][2]) + i));
    for (const r of rows) expect(src.split('\n')[Number(r[2]) - 1]).toBe(text(r[5]));
    expect(card('09b5')).toContain('<span class="mono">sine_09b5</span>');
    expect(card('9000')).toContain('not in the exported source');
    expect(card('9000')).not.toContain('class="code"');
  });

  it('lists the comments with their kind, place and code line', () => {
    const p = annotated(), { R, S } = build(p);
    const doc = notesDocument(p, R, S)!;
    const items = [...doc.matchAll(/<li class="cm-item">([\s\S]*?)<\/li>/g)].map(m => m[1]);
    expect(items.map(i => [/\$([0-9a-f]{4})/.exec(i)![1], /<span class="tag">([^<]+)</.exec(i)![1]])).toEqual([
      ['0810', 'Block comment'], ['0813', 'Comment line'], ['0816', 'End of line'], ['09b5', 'Comment block'],
    ]);
    // the address links to a bookmark at the same place
    expect(items[0]).toContain('<a href="#bm-0810">$0810</a>');
    expect(items[3]).toContain('<div class="note">curve for the\nsprite x position</div>');
    expect(text(items[2])).toContain('sei');
    // a comment the source does not have (not at the start of a line) is left out
    expect(doc).not.toContain('kept anyway');
  });

  it('lists the comments on a zero-page variable with its name and .label line', () => {
    const p: Project = { ...demoProject(), labels: { 0xfb: 'fx_ptr' }, comments: { 0xfb: 'screen pointer' }, notes: { 0xfb: { text: 'set by the irq' } } };
    const { R, S } = build(p);
    const doc = notesDocument(p, R, S)!;
    const items = [...doc.matchAll(/<li class="cm-item">([\s\S]*?)<\/li>/g)].map(m => text(m[1]));
    expect(items).toHaveLength(2);
    for (const i of items) expect(i).toMatch(/\$00fb\s*fx_ptr/);
    expect(items[0]).toContain('Comment line');
    expect(items[1]).toContain('End of line');
    expect(items[1]).toContain('.label fx_ptr = $fb');
    expect(notesText(p, R, S)).toMatch(/\$00fb {2}fx_ptr · End of line[\s\S]*screen pointer[\s\S]*\.label fx_ptr = \$fb +\/\/ screen pointer/);
  });

  it('is exported with the time and named in the README', () => {
    const p = annotated(), { R, S } = build(p);
    const out = exportFiles(p, R, S, null, new Date(2026, 9, 23, 16, 5));
    expect(out[NOTES_FILE]).toContain('<dt>Exported</dt><dd>2026-10-23 16:05</dd>');
    expect(out['README.md']).toContain(`- \`${NOTES_FILE}\` — your bookmarks and comments`);
    expect(notesDocument(p, R, S)).not.toContain('Exported');
  });
});

describe('NOTES.txt', () => {
  const txtS = (p: Project): Settings => ({ ...DEFAULT_SETTINGS, ...p.settings, notesFormat: 'txt' });

  it('is plain text with the same bookmarks, comments and code lines', () => {
    const p = annotated(), S = txtS(p), { R } = build(p, S);
    const doc = notesText(p, R, S, new Date(2026, 9, 23, 16, 5))!;
    const src = (R.files['raster-demo.asm'] as string).split('\n');
    const lines = doc.split('\n');
    expect(lines.slice(0, 2)).toEqual(['raster-demo: bookmarks and comments', '='.repeat('raster-demo: bookmarks and comments'.length)]);
    expect(doc).toContain('Files:     raster-demo.prg  $0801-$37ff');
    expect(doc).toContain('Exported:  2026-10-23 16:05');
    expect(doc).toContain('3 bookmarks and 4 comments in the re-assembled source.');
    expect(doc).not.toMatch(/<\/?(span|div|a)\b|&lt;|&amp;/);
    // the notes as written, indented under their bookmark
    expect(doc).toContain('$0810  Set up\n  start · Code · start · $0810-$0865 (86 bytes) · raster-demo.asm, line ' + (src.findIndex(l => l.trimStart().startsWith('jsr CLRSCR')) + 1));
    expect(doc).toContain('  clears the screen\n  then starts the <raster> IRQ & music');
    expect(doc).toContain('$09b5  sine table\n  sine_09b5 · ');
    expect(doc).toContain('  (no note)');
    expect(doc).toContain('$9000  not loaded\n  not in the exported source');
    // the contents, then each bookmark: the headings keep the order of the addresses
    expect(lines.filter(l => /^\$[0-9a-f]{4} {2}\S/.test(l) && !/·/.test(l)).map(l => l.slice(1, 5))).toEqual(['0810', '09b5', '9000']);
    // every code line is the line of the .asm file with that number; ">" marks the bookmarked one
    const rows = lines.map(l => /^ {2}([> ]) +(\d+) {2}([0-9a-f ]{4}) {2}(.{10}) {2}(.*)$/.exec(l)).filter(m => !!m);
    expect(rows.length).toBeGreaterThan(10);
    for (const m of rows) expect(src[Number(m[2]) - 1].trimEnd()).toBe(m[5]);
    expect(rows.filter(m => m[1] === '>').map(m => m[3])).toEqual(['0810', '09b5']);
    expect(doc).toContain('COMMENTS IN THE SOURCE (4)');
    expect(doc).toContain(`$0816  start+6 · End of line · raster-demo.asm, line ${src.findIndex(l => l.trimStart().startsWith('sei')) + 1}\n  no interrupts while we set up\n`);
    expect(doc).not.toContain('kept anyway');
    expect(doc.endsWith('and are not part of the source.\n')).toBe(true);
  });

  it('is what the export writes when the setting asks for it, and the README names it', () => {
    const p = annotated(), { R } = build(p);
    const files = (notesFormat: Settings['notesFormat']) => exportFiles(p, R, { ...DEFAULT_SETTINGS, notesFormat });
    const txt = files('txt'), html = files('html'), none = files('none');
    expect([NOTES_FILE in txt, NOTES_TEXT_FILE in txt]).toEqual([false, true]);
    expect(txt['README.md']).toContain(`- \`${NOTES_TEXT_FILE}\` — your bookmarks and comments, each with the code around it, as plain text`);
    expect([NOTES_FILE in html, NOTES_TEXT_FILE in html]).toEqual([true, false]);
    expect([NOTES_FILE in none, NOTES_TEXT_FILE in none]).toEqual([false, false]);
    expect(none['README.md']).not.toContain('NOTES');
    // nothing to write: no file in either format
    const plain = demoProject(), r = build(plain);
    expect(notesText(plain, r.R, txtS(plain))).toBeNull();
    expect(NOTES_TEXT_FILE in exportFiles(plain, r.R, txtS(plain))).toBe(false);
  });
});
