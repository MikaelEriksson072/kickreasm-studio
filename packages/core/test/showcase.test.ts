/* The showcase (the app's Demo): it builds, the analysis finds one block of every type in it (a bitmap logo above a
 * text screen needs bank tracking to tell the two $d018 values apart), the source assembles to the same bytes, and
 * the tour project's bookmarks, names and comments sit where they should without changing a byte. */
import { describe, expect, it } from 'vitest';
import { analyze, findBlock, makeShowcase, parsePrg, render, showcaseProject, TYPE_INFO, verify, type BlockKind } from '../src';

const d = makeShowcase();
const file = parsePrg(d.name, d.prg);
const L = d.labels;

describe('the showcase', () => {
  const A = analyze({ files: [file] });
  const typeAt = (a: number) => findBlock(A.blocks, a)?.type;

  it('is a PRG from $0801 started by 2026 SYS2064', () => {
    expect(file.load).toBe(0x0801);
    expect(A.basics[0]).toMatchObject({ sys: 0x0810 });
    expect(A.entry).toBe(0x0810);
  });

  it('has one block of every type the analysis finds', () => {
    const all = Object.values(TYPE_INFO).map(t => t.key).sort();
    expect([...new Set(A.blocks.map(b => b.type))].sort()).toEqual(all);
    const want: [number, BlockKind][] = [
      [0x0801, 'basic'], [0x0810, 'code'], [L.fx_table, 'words'], [L.frame, 'data'], [L.crow_lo, 'lohi'], [L.crow_hi, 'lohi'],
      [L.wash_colors, 'table'], [L.sine, 'table'], [L.bar_colors, 'table'], [L.logo_colors, 'table'],
      [L.title, 'text'], [L.subtitle, 'text'], [L.info_1, 'text'], [L.keys_text, 'text'], [L.scrolltext, 'text'],
      [0x1800, 'music'], [0x2000, 'sprite'], [0x2800, 'charset'], [0x4000, 'bitmap'], [0x6000, 'screen'], [0x3000, 'fill'],
    ];
    for (const [a, t] of want) expect(typeAt(a), `$${a.toString(16)}`).toBe(t);
    expect(findBlock(A.blocks, L.title)!.props.enc).toBe('petscii');
    expect(findBlock(A.blocks, L.scrolltext)!.props.enc).toBe('screen');
  });

  it('is traced through its raster IRQs, the NMI and the word jump table', () => {
    const msgs = A.log.map(l => l.msg);
    for (const h of ['irq_top', 'irq_split', 'irq_scroll']) expect(A.entryKind.get(L[h]), h).toBe('irq');
    expect(A.entryKind.get(L.nmi)).toBe('nmi');
    expect(msgs).toContain(`Word table at $${L.fx_table.toString(16).padStart(4, '0')}: 3 code addresses (jump table via ($${L.fx_vector.toString(16).padStart(4, '0')}))`);
    for (const fx of ['fx_wave', 'fx_circle', 'fx_bounce']) expect(A.insLen[L[fx]], fx).toBeGreaterThan(0);
    expect(A.smc.size).toBeGreaterThan(0);
    expect(msgs.some(m => /^Music detected at \$1800/.test(m))).toBe(true);
    expect(msgs).toContain('Bitmap at $4000 ($d011 bitmap mode + $d018=$80)');
    expect(msgs).toContain('Charset at $2800 ($d018=$1a selects charset at $2800)');
    expect(msgs).toContain('Screen matrix at $6000 ($d018=$80 selects screen at $6000)');
  });

  it('round-trips byte for byte, with the word table, music and graphics as KickAss writes them', () => {
    const R = render(A, { files: [file] });
    const V = verify(A, R);
    expect(V.ok).toBe(true);
    expect(V.results[0]).toMatchObject({ same: file.bytes.length, total: file.bytes.length });
    expect(Object.keys(R.files)).toEqual(expect.arrayContaining(['music/music_1800.sid', 'gfx/charset_2800.bin', 'gfx/bitmap_4000.bin']));
  });

  it('the tour project: bookmarks in address order on loaded lines, names and comments, still the same bytes', () => {
    const p = showcaseProject();
    const PA = analyze(p), R = render(PA, p), V = verify(PA, R);
    expect(V.ok).toBe(true);
    const tour = Object.keys(p.bookmarks).map(Number);
    expect(tour.length).toBe(15);
    for (const a of tour) expect(PA.owner[a], `$${a.toString(16)}`).toBeGreaterThanOrEqual(0);
    expect(p.bookmarks[0x0801].title).toBe('Welcome to the showcase');
    const src = R.files['mimir-showcase.asm'] as string;
    expect(src).toMatch(/\.word fx_wave\n\s+\.word fx_circle\n\s+\.word fx_bounce\n/);
    expect(src).toMatch(/\/\/ set by setup_screen from crow_lo\/crow_hi\n\.label row_ptr = \$fb +\/\/ a colour RAM row of the info lines/);
    expect(src).toMatch(/\/\/ VIC bank 1: \$4000-\$7fff/);
    expect(src).toMatch(/\/\/ line 20: bars in the top border, then the logo in VIC bank 1\nirq_top:/);
    expect(src).toContain('// MIMIR in the demo font: 160 x 64 multicolor pixels');
  });

  it('needs bank tracking to tell the logo bitmap from the text charset (a split screen)', () => {
    const off = analyze({ files: [file], settings: { bankTracking: false } });
    // without it every $d018 value counts as a bitmap once bitmap mode is on anywhere
    expect(off.log.map(l => l.msg)).not.toContain('Charset at $2800 ($d018=$1a selects charset at $2800)');
  });
});
