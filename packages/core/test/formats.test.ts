/* Number formats (spec 10.2): data, tables and words written in hex, decimal or binary (bits), several a row, with
 * words also as addresses (labels, the default). Every format re-assembles to the same bytes. */
import { describe, expect, it } from 'vitest';
import { analyze, findBlock, formatOverride, makeDemo, parsePrg, render, verify, type Override, type ProjectInput } from '../src';

const demo = (overrides: Override[] = []): ProjectInput => { const d = makeDemo(); return { name: 'raster-demo', files: [parsePrg(d.name, d.prg)], overrides }; };
const source = (p: ProjectInput) => {
  const A = analyze(p), R = render(A, p);
  expect(verify(A, R).ok).toBe(true);
  return { A, lines: (R.files[`${R.fileNames[0]}.asm`] as string).split('\n') };
};
// the demo's colour table at $0939 (16 bytes: $06, $0e, $03, $01, $03, $0e, $06, $00, $09, $08, $07, $01, $07, $08, $09, $00)
const WORDS: Override = { start: 0x0939, end: 0x0949, type: 'words' };
const block = (p: ProjectInput, a: number) => findBlock(analyze(p).blocks, a)!;

describe('number formats', () => {
  it('writes a table in decimal or binary, as many a row as set', () => {
    const bin = demo([formatOverride(block(demo(), 0x0939), { fmt: 'bin', row: 4 })]);
    const { A, lines } = source(bin);
    expect(findBlock(A.blocks, 0x0939)).toMatchObject({ type: 'table', props: { sub: 'colors', fmt: 'bin', row: 4 } });
    const at = lines.indexOf('colors_0939:');
    expect(lines.slice(at + 1, at + 3).map(l => l.trim())).toEqual(['.byte %00000110, %00001110, %00000011, %00000001', '.byte %00000011, %00001110, %00000110, %00000000']);
    const dec = source(demo([formatOverride(block(demo(), 0x0939), { fmt: 'dec', row: 16 })])).lines;
    expect(dec[dec.indexOf('colors_0939:') + 1].trim()).toBe('.byte 6, 14, 3, 1, 3, 14, 6, 0, 9, 8, 7, 1, 7, 8, 9, 0');
  });

  it('writes words as addresses by default, or as hex, decimal or binary numbers, several a row', () => {
    const words = demo([WORDS]);
    const addr = source(words).lines;
    expect(addr.filter(l => l.trim().startsWith('.word')).slice(0, 2).map(l => l.trim())).toEqual(['.word $0e06', '.word $0103']);
    const w = block(words, 0x0939);
    const as = (fmt: 'hex' | 'dec' | 'bin', row: number) => source(demo([WORDS, formatOverride(w, { fmt, row })])).lines.filter(l => l.trim().startsWith('.word')).map(l => l.trim());
    expect(as('hex', 4)).toEqual(['.word $0e06, $0103, $0e03, $0006', '.word $0809, $0107, $0807, $0009']);
    expect(as('dec', 8)).toEqual(['.word 3590, 259, 3587, 6, 2057, 263, 2055, 9']);
    expect(as('bin', 2)[0]).toBe('.word %0000111000000110, %0000000100000011');
  });

  it('keeps the type and settings of the block, and drops a default', () => {
    const t = block(demo(), 0x0939);
    expect(formatOverride(t, { fmt: 'bin' })).toEqual({ start: 0x0939, end: 0x0949, type: 'table', props: { sub: 'colors', fmt: 'bin' } });
    // hex is the default of data and tables, addresses (no format) the default of words; a row of null is the setting's
    const marked = block(demo([formatOverride(t, { fmt: 'dec', row: 4 })]), 0x0939);
    expect(formatOverride(marked, { fmt: 'hex' })).toEqual({ start: 0x0939, end: 0x0949, type: 'table', props: { sub: 'colors', row: 4 } });
    expect(formatOverride(marked, { row: null }).props).toEqual({ sub: 'colors', fmt: 'dec' });
    const w = block(demo([WORDS]), 0x0939);
    expect(formatOverride(w, { fmt: 'hex' }).props).toEqual({ fmt: 'hex' });
    expect(formatOverride(block(demo([WORDS, formatOverride(w, { fmt: 'dec' })]), 0x0939), { fmt: null })).toEqual(WORDS);
  });

  it('keeps a change made before the analysis caught up with it (the last override over the block)', () => {
    const w = block(demo([WORDS]), 0x0939);
    const first = formatOverride(w, { fmt: 'dec' }, [WORDS]);
    // the second change still sees the block without the format
    expect(formatOverride(w, { row: 4 }, [WORDS, first])).toEqual({ ...WORDS, props: { fmt: 'dec', row: 4 } });
  });
});
