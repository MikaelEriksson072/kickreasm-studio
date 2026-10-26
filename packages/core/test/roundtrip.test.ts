import { describe, expect, it } from 'vitest';
import {
  analyze, assemble, buildScripts, comparePrg, DEFAULT_SETTINGS, demoProject, deserializeProject, exportFiles, findBlock, h2, h4, lineMove, lineText, makeDemo, makePsid, markIdOf, mergeOverride, mergeRange, moveBlockKeys, moveBytes, parsePrg, parsePsid, projectScripts, render, serializeProject, verify, validLabel,
  type ByteMove, type Project, type ProjectInput,
} from '../src';
import { fromSource, SETTING_VARIANTS } from './helpers/programs';

const demoInput = (): ProjectInput => {
  const d = makeDemo();
  return { name: 'raster-demo', files: [parsePrg(d.name, d.prg)], overrides: [], labels: {}, comments: {}, settings: {} };
};

const roundTrip = (p: ProjectInput) => {
  const A = analyze(p);
  const R = render(A, p);
  const V = verify(A, R);
  return { A, R, V };
};

const failure = (V: ReturnType<typeof verify>) => V.results.map(r => ({ file: r.file, errors: r.errors.slice(0, 5), diffs: r.diffs.slice(0, 5) }));

describe('demo program', () => {
  const p = demoInput();
  const { A, R, V } = roundTrip(p);

  it('is the 12 287-byte raster demo', () => {
    expect(p.files[0].load).toBe(0x0801);
    expect(p.files[0].bytes.length).toBe(12287);
  });

  it('re-assembles byte-identical', () => {
    expect(V.ok, JSON.stringify(failure(V))).toBe(true);
    const r = V.results[0];
    expect(r.same).toBe(r.total);
    expect(r.prg).toEqual(makeDemo().prg);
  });

  it('finds the structure the spec describes', () => {
    const at = (a: number) => findBlock(A.blocks, a);
    expect(at(0x0801)?.type).toBe('basic');
    expect(at(0x0810)?.type).toBe('code');
    expect(at(0x1000)?.type).toBe('music');
    expect(at(0x2000)?.type).toBe('sprite');
    expect(at(0x3000)?.type).toBe('charset');
    expect(A.entry).toBe(0x0810);
    expect(A.music.map(m => [m.start, m.init, m.play])).toEqual([[0x1000, 0x1000, 0x1003]]);
    expect(A.stats.illegal).toBe(3); // lax, sax, dcp in the IRQ
    expect(A.skip.size).toBe(1); // the BIT-skip in border_red
    const names = [...A.labels.values()].map(l => l.name);
    expect(names).toContain('start');
    expect(names.some(n => n.startsWith('irq_'))).toBe(true);
    expect(names.some(n => n.startsWith('fx_'))).toBe(true);
    expect(names.some(n => n.startsWith('smc_'))).toBe(true);
    expect(names.some(n => n.startsWith('sine_'))).toBe(true);
  });

  it('writes the idiomatic Kick constructs', () => {
    const src = R.files['raster-demo.asm'] as string;
    expect(src).toContain('BasicUpstart2(start)');
    expect(src).toContain('#import "include/c64-hardware.asm"');
    expect(src).toContain('.var music = LoadSid("music/music_1000.sid")');
    expect(src).toContain('jsr music.init');
    expect(src).toContain('.fill music.size, music.getData(i)');
    expect(src).toContain('.import binary "gfx/charset_3000.bin"');
    expect(src).toMatch(/lda #<irq_[0-9a-f]{4}/);
    expect(src).toMatch(/sta CINV\b/);
    expect(src).toContain('jmp *');
    expect(src).toMatch(/\.byte \$2c +\/\/ bit/);
    expect(src).toMatch(/inc smc_[0-9a-f]{4}\+1/);
    expect(Object.keys(R.files).sort()).toEqual(['gfx/charset_3000.bin', 'include/c64-hardware.asm', 'music/music_1000.sid', 'raster-demo.asm']);
  });

  it('keeps one line model for listing and export', () => {
    const fileLines = R.fileLines['raster-demo.asm'];
    const listed = R.lines.filter(l => l.k !== 'file');
    expect(listed).toEqual(fileLines);
    for (const l of listed) if ('n' in l && l.n > 0) expect(l.a).toBeGreaterThanOrEqual(0x0801);
  });

  it('round-trips under every output setting variant', () => {
    for (const settings of SETTING_VARIANTS) {
      const q = { ...demoInput(), settings };
      const { V: v } = roundTrip(q);
      expect(v.ok, `${JSON.stringify(settings)}: ${JSON.stringify(failure(v))}`).toBe(true);
    }
  });

  it('round-trips with renamed labels and comments everywhere', () => {
    const labels: Record<number, string> = {};
    let i = 0;
    for (const [a] of A.labels) labels[a] = `renamed_${i++}`;
    const comments: Record<number, string> = {};
    for (const l of R.lines) if ((l.k === 'ins' || l.k === 'dat') && l.a % 3 === 0) comments[l.a] = `note "${l.a}" // with /* tricky */ chars`;
    const blockComments: Record<number, string> = {};
    for (const b of A.blocks) blockComments[b.start] = `block ${b.id}`;
    const { R: r2, V: v2 } = roundTrip({ ...demoInput(), labels, comments, blockComments });
    expect(v2.ok, JSON.stringify(failure(v2))).toBe(true);
    expect(r2.files['raster-demo.asm']).toContain('renamed_0');
  });

  it('round-trips after user overrides of every kind', () => {
    for (const type of ['code', 'data', 'words', 'text', 'table', 'sprite', 'charset', 'bitmap', 'screen', 'music', 'fill', 'lohi'] as const) {
      const q = { ...demoInput(), overrides: [{ start: 0x0a00, end: 0x0b00, type }, { start: 0x2000, end: 0x2040, type }] };
      const { V: v } = roundTrip(q);
      expect(v.ok, `${type}: ${JSON.stringify(failure(v))}`).toBe(true);
    }
  });

  it('keeps bytes marked as Bytes as plain user Data instead of detecting them again', () => {
    expect(findBlock(A.blocks, 0x09b5)).toMatchObject({ start: 0x09b5, end: 0x0ab5, type: 'table', props: { sub: 'sine' }, user: false });
    expect(findBlock(A.blocks, 0x0949)).toMatchObject({ start: 0x0949, end: 0x0960, type: 'text', user: false });
    const overrides = [
      { start: 0x09b5, end: 0x09d5, type: 'data' as const }, // the head of the sine table
      { start: 0x0949, end: 0x0951, type: 'data' as const }, // the head of a PETSCII string
      { start: 0x0960, end: 0x0970, type: 'data' as const }, // two adjacent Bytes overrides stay two blocks
      { start: 0x0970, end: 0x0985, type: 'data' as const, props: { fmt: 'bin' as const } },
    ];
    const { A: a2, R: r2, V: v2 } = roundTrip({ ...demoInput(), overrides });
    expect(v2.ok, JSON.stringify(failure(v2))).toBe(true);
    const at = (a: number) => findBlock(a2.blocks, a);
    for (const o of overrides) expect(at(o.start)).toMatchObject({ start: o.start, end: o.end, type: 'data', user: true, conf: 1, reason: 'user override' });
    expect(at(0x0970)!.props.fmt).toBe('bin');
    // detection still runs on the unmarked rest
    expect(at(0x09d5)).toMatchObject({ start: 0x09d5, end: 0x0ab5, type: 'table', props: { sub: 'sine' }, user: false });
    expect(at(0x0951)).toMatchObject({ start: 0x0951, end: 0x0960, type: 'text', user: false });
    // the listing shows a Data header with plain .byte rows
    const hdr = r2.lines.find(l => l.k === 'hdr' && l.a === 0x09b5);
    expect(hdr && 'text' in hdr && hdr.text).toMatch(/^Data · \w+ · \$09b5-\$09d4 \(32 bytes\)$/);
    const rows = r2.lines.filter(l => l.k === 'dat' && l.a >= 0x09b5 && l.a < 0x09d5);
    expect(rows.length).toBeGreaterThan(0);
    for (const l of rows) expect(l.k === 'dat' && l.dir).toBe('.byte');
  });

  it('merges the overrides inside a newly marked range into one block', () => {
    const blocksIn = (a: ReturnType<typeof analyze>, s: number, e: number) => a.blocks.filter(b => b.start < e && b.end > s).map(b => ({ start: b.start, end: b.end, type: b.type, props: b.props, user: b.user }));
    const check = (overrides: ProjectInput['overrides']) => {
      const r = roundTrip({ ...demoInput(), overrides });
      expect(r.V.ok, JSON.stringify(failure(r.V))).toBe(true);
      return r.A;
    };
    // earlier Bytes, Text and Table (with props) overrides inside $0939-$09b4 leave no boundary or props behind
    for (const type of ['table', 'data', 'text', 'fill'] as const) {
      const a2 = check([
        { start: 0x0949, end: 0x0951, type: 'data' },
        { start: 0x0960, end: 0x0970, type: 'text', props: { enc: 'screen' } },
        { start: 0x0975, end: 0x0985, type: 'table', props: { sub: 'sine' } },
        { start: 0x0939, end: 0x09b5, type },
      ]);
      expect(blocksIn(a2, 0x0939, 0x09b5), type).toEqual([{ start: 0x0939, end: 0x09b5, type, props: type === 'text' ? { enc: 'petscii' } : type === 'fill' ? { value: a2.mem[0x0939] } : {}, user: true }]);
    }
    // an override the new one covers only in part keeps the rest as its own block, with its props
    expect(blocksIn(check([{ start: 0x0940, end: 0x0990, type: 'text', props: { enc: 'screen' } }, { start: 0x0939, end: 0x0960, type: 'table' }]), 0x0939, 0x0990)).toEqual([
      { start: 0x0939, end: 0x0960, type: 'table', props: {}, user: true },
      { start: 0x0960, end: 0x0990, type: 'text', props: { enc: 'screen' }, user: true },
    ]);
    // a covered code override no longer adds an entry point that splits the new code block
    const code = check([{ start: 0x0985, end: 0x0995, type: 'code' }, { start: 0x0939, end: 0x09b5, type: 'code' }]);
    expect(blocksIn(code, 0x0939, 0x09b5)).toEqual([{ start: 0x0939, end: 0x09b5, type: 'code', props: {}, user: true }]);
    expect(code.entryKind.has(0x0985)).toBe(false);
    // and "Clear override" really returns marked code to automatic analysis
    const cleared = check([{ start: 0x0939, end: 0x0949, type: 'code' }, { start: 0x0939, end: 0x0949, type: 'auto' }]);
    expect(blocksIn(cleared, 0x0939, 0x09b5)).toEqual(blocksIn(A, 0x0939, 0x09b5));
  });
});

describe('excluding blocks from the build', () => {
  const base = demoInput();
  const A0 = analyze(base);
  const music = A0.music[0];
  const excluded = [0x09b5, music.start];
  const p = { ...base, excluded };
  const { R, V } = roundTrip(p);
  const src = R.files['raster-demo.asm'] as string;

  it('leaves the bytes out, keeps the labels and still verifies', () => {
    expect(V.ok, JSON.stringify(failure(V))).toBe(true);
    const r = V.results[0];
    expect(r.excluded).toBe(256 + (music.end - music.start));
    expect(r.same).toBe(r.total);
    expect(r.total).toBe(12287 - r.excluded);
    // a gap Kick Assembler fills with zeros
    const prg = r.prg!;
    for (let a = 0x09b5; a < 0x0ab5; a++) expect(prg[a - 0x0801 + 2]).toBe(0);
    expect(R.excluded).toEqual([{ start: 0x09b5, end: 0x0ab5, file: 0, name: 'INCLUDE_sine_09b5' }, { start: music.start, end: music.end, file: 0, name: `INCLUDE_${R.labels.get(music.start)?.name ?? h4(music.start)}` }]);
  });

  it('keeps the block in the source under #if, with its labels in #else and a #define to put it back', () => {
    expect(src).toContain('#if INCLUDE_sine_09b5\n');
    expect(src).toMatch(/#else\n\.label sine_09b5 = \$09b5\n#endif\n/);
    expect(src).toContain('// #define INCLUDE_sine_09b5\n');
    expect(R.lines.some(l => l.k === 'hdr' && l.a === 0x09b5 && l.excluded && /excluded from the build$/.test(l.text))).toBe(true);
  });

  it('builds the original again when the blocks are defined back in', () => {
    const defs = R.excluded.map(x => `#define ${x.name}`).join('\n');
    const files = { ...R.files, 'raster-demo.asm': `${defs}\n${src}` };
    const asm = assemble(files, 'raster-demo.asm');
    expect(asm.errors).toEqual([]);
    expect(comparePrg(base.files[0], asm.prg).ok).toBe(true);
  });

  it('moves the start of the output when the first block is left out', () => {
    const first = A0.blocks[0];
    const { V: v } = roundTrip({ ...base, excluded: [first.start] });
    expect(v.ok, JSON.stringify(failure(v))).toBe(true);
    const prg = v.results[0].prg!;
    expect(prg[0] | (prg[1] << 8)).toBe(first.end);
  });
});

describe('merging a block with its neighbour', () => {
  const base = demoInput();
  const A0 = analyze(base);
  const merged = (at: number, dir: 'prev' | 'next') => {
    const m = mergeOverride(A0, at, dir)!;
    const p = { ...base, overrides: [m.override] };
    const r = roundTrip(p);
    expect(r.V.ok, JSON.stringify(failure(r.V))).toBe(true);
    return { m, A: r.A };
  };

  it('makes one block of the type of the block it starts from', () => {
    const { m, A } = merged(0x0960, 'prev'); // txt_0960 + txt_0949
    expect(m.override).toEqual({ start: 0x0949, end: 0x0985, type: 'text', props: { enc: 'petscii' } });
    expect(findBlock(A.blocks, 0x0949)).toMatchObject({ start: 0x0949, end: 0x0985, type: 'text', user: true });
    const t = merged(0x0939, 'next'); // the color table takes in the text after it
    expect(t.m.override).toEqual({ start: 0x0939, end: 0x0960, type: 'table', props: { sub: 'colors' } });
    expect(findBlock(t.A.blocks, 0x0950)).toMatchObject({ start: 0x0939, end: 0x0960, type: 'table' });
  });

  it('keeps init and play when music takes in the block before it', () => {
    const { m, A } = merged(0x1000, 'prev');
    expect(m.other.type).toBe('fill');
    expect(m.override).toMatchObject({ start: m.other.start, end: A0.music[0].end, type: 'music', props: { init: 0x1000, play: 0x1003 } });
    expect(A.music.map(x => [x.start, x.init, x.play])).toEqual([[m.other.start, 0x1000, 0x1003]]);
  });

  it('turns a lo/hi table into data, and needs a neighbour in the same file', () => {
    expect(mergeOverride(A0, 0x0931, 'next')!.into).toBe('data');
    expect(mergeOverride(A0, 0x0801, 'prev')).toBeNull();
    expect(mergeOverride(A0, A0.blocks[A0.blocks.length - 1].start, 'next')).toBeNull();
  });
});

describe('moving bytes into the neighbouring block (dragging a line in the listing)', () => {
  const base = demoInput();
  const A0 = analyze(base), R0 = render(A0, base);
  const moved = (m: ByteMove | { error: string } | null) => {
    if (!m || 'error' in m) throw new Error(`no move: ${JSON.stringify(m)}`);
    const r = roundTrip({ ...base, overrides: m.overrides });
    expect(r.V.ok, JSON.stringify(failure(r.V))).toBe(true);
    return r.A;
  };
  const lineAt = (a: number) => R0.lines.find(l => l.a === a && 'n' in l && l.n > 0)!;

  it('moves the first byte of a block up into the block before it', () => {
    const m = moveBytes(A0, 0x0960, 0x0961, 'prev') as ByteMove;
    // the text it leaves keeps its type: detection could read a shorter text as something else
    expect(m.overrides).toEqual([
      { start: 0x0961, end: 0x0985, type: 'text', props: { enc: 'petscii' } },
      { start: 0x0949, end: 0x0961, type: 'text', props: { enc: 'petscii' } },
    ]);
    expect([m.from.start, m.into.start, m.rekey]).toEqual([0x0960, 0x0949, { from: 0x0960, to: 0x0961 }]);
    const A = moved(m);
    expect(findBlock(A.blocks, 0x0960)).toMatchObject({ start: 0x0949, end: 0x0961, type: 'text', user: true });
    expect(findBlock(A.blocks, 0x0961)).toMatchObject({ start: 0x0961, end: 0x0985, type: 'text' });
    // the line's move is the same byte, although the line holds more
    expect(lineAt(0x0960)).toMatchObject({ k: 'dat', dir: '.text' });
    expect(lineMove(A0, lineAt(0x0960), 'prev')).toEqual(m);
    expect(lineMove(A0, lineAt(0x0960), 'next')).toBeNull();
  });

  it('moves the last byte down into the block after it, the block it leaves keeping its settings', () => {
    const last = R0.lines.filter(l => 'n' in l && l.n > 0 && l.a >= 0x0939 && l.a < 0x0949).pop()!;
    const m = lineMove(A0, last, 'next')!;
    expect([m.start, m.end, m.rekey]).toEqual([0x0948, 0x0949, { from: 0x0949, to: 0x0948 }]);
    const A = moved(m);
    expect(findBlock(A.blocks, 0x0939)).toMatchObject({ start: 0x0939, end: 0x0948, type: 'table', props: { sub: 'colors' } });
    expect(findBlock(A.blocks, 0x0948)).toMatchObject({ start: 0x0948, end: 0x0960, type: 'text' });
  });

  it('moves a whole instruction out of code, and a byte of data into it', () => {
    const last = R0.lines.find(l => l.k === 'ins' && l.a + l.n === 0x092d)!;
    const out = lineMove(A0, last, 'next')!;
    expect([out.start, out.end, out.into.type]).toEqual([last.a, 0x092d, 'data']);
    expect(findBlock(moved(out).blocks, last.a)).toMatchObject({ start: last.a, end: 0x0931, type: 'data' });
    const inn = lineMove(A0, lineAt(0x092d), 'prev')!;
    expect([inn.start, inn.end, inn.overrides]).toEqual([0x092d, 0x092e, [{ start: 0x0927, end: 0x092e, type: 'code' }]]);
    expect(findBlock(moved(inn).blocks, 0x092d)).toMatchObject({ start: 0x0927, end: 0x092e, type: 'code' });
  });

  it('keeps music init and play, and the fill before it a fill', () => {
    const m = moveBytes(A0, 0x0fff, 0x1000, 'next') as ByteMove;
    expect(m.overrides).toEqual([{ start: 0x0ab5, end: 0x0fff, type: 'fill' }, { start: 0x0fff, end: 0x10b0, type: 'music', props: { init: 0x1000, play: 0x1003 } }]);
    const A = moved(m);
    expect(A.music.map(x => [x.start, x.end, x.init, x.play])).toEqual([[0x0fff, 0x10b0, 0x1000, 0x1003]]);
    expect(findBlock(A.blocks, 0x0ffe)).toMatchObject({ start: 0x0ab5, end: 0x0fff, type: 'fill' });
  });

  it('says why bytes cannot move', () => {
    expect(moveBytes(A0, 0x0961, 0x0962, 'prev')).toEqual({ error: '$0961 is not at the start of its block' });
    expect(moveBytes(A0, 0x0948, 0x094a, 'next')).toEqual({ error: '$0948-$0949 is not inside one block' });
    expect(moveBytes(A0, 0x080d, 0x080e, 'prev')).toEqual({ error: 'the BASIC stub is read from its lines' });
    expect(moveBytes(A0, 0x0919, 0x091a, 'prev')).toEqual({ error: 'code stays split per routine' });
    expect(moveBytes(A0, 0x37ff, 0x3800, 'next')).toEqual({ error: 'there is no next block in this file' });
    expect(lineMove(A0, R0.lines.find(l => l.k === 'hdr' && l.a === 0x0960)!, 'prev')).toBeNull();
  });

  it('takes the block comment, the build exclusion and the binary file along to the new start', () => {
    const p = { blockComments: { 0x0960: 'greeting', 0x0985: 'scroller' } as Record<number, string>, excluded: [0x0960, 0x2000], binary: [0x0960] };
    moveBlockKeys(p, 0x0960, 0x0961);
    expect(p).toEqual({ blockComments: { 0x0961: 'greeting', 0x0985: 'scroller' }, excluded: [0x0961, 0x2000], binary: [0x0961] });
    moveBlockKeys(p, 0x0985, 0x0985);
    expect(p.blockComments[0x0985]).toBe('scroller');
  });
});

describe('renaming zero-page variables', () => {
  it('renames a pointer everywhere, its high byte included', () => {
    const { R, V } = roundTrip({ ...demoInput(), labels: { 0xfb: 'fx_ptr' } });
    expect(V.ok, JSON.stringify(failure(V))).toBe(true);
    const text = R.files['raster-demo.asm'] as string;
    expect(text).toContain('.label fx_ptr = $fb');
    expect(text).toMatch(/sta fx_ptr\b/);
    expect(text).toContain('sta fx_ptr+1');
    expect(text).toContain('jmp (fx_ptr)');
    expect(text).not.toContain('ptr_fb');
    expect(R.zp.get(0xfb)).toMatchObject({ name: 'fx_ptr', user: true });
  });

  it('comments a zero-page variable at the end of its .label line and above it, like a block', () => {
    const notes = { 0xfb: { text: 'where the effect writes\non the screen' } };
    const { R, V } = roundTrip({ ...demoInput(), labels: { 0xfb: 'fx_ptr' }, comments: { 0xfb: 'screen pointer' }, notes });
    expect(V.ok, JSON.stringify(failure(V))).toBe(true);
    const text = R.files['raster-demo.asm'] as string;
    expect(text).toMatch(/\/\/ where the effect writes\n\/\/ on the screen\n\.label fx_ptr = \$fb +\/\/ screen pointer\n/);
    // a comment block above it instead
    const block = roundTrip({ ...demoInput(), notes: { 0xfb: { text: 'pointer into\nthe screen', block: true } } });
    expect(block.V.ok, JSON.stringify(failure(block.V))).toBe(true);
    expect(block.R.files['raster-demo.asm']).toContain(`/*\npointer into\nthe screen\n*/\n.label ${block.R.zp.get(0xfb)!.name} = $${h2(0xfb)}\n`);
    // the lines carry the variable's address; the listing shows them in the file head
    const lines = R.fileLines['raster-demo.asm'];
    const def = lines.find(l => l.k === 'dir' && l.zp === 0xfb)!;
    expect(def).toMatchObject({ cmt: 'screen pointer', userCmt: true, a: 0x0801 });
    expect(lines.filter(l => l.k === 'cmt' && l.zp === 0xfb).map(l => (l as { text: string }).text)).toEqual(['where the effect writes', 'on the screen']);
    // nothing in the program's bytes gets them
    expect(lines.filter(l => 'n' in l && l.n > 0 && 'userCmt' in l && l.userCmt)).toEqual([]);
  });
});

describe('blocks saved as binary files', () => {
  const A0 = analyze(demoInput());
  const src = (R: ReturnType<typeof render>) => R.files['raster-demo.asm'] as string;

  it('writes the block to data/<label>.bin and loads it with .import binary', () => {
    const { A, R, V } = roundTrip({ ...demoInput(), binary: [0x09b5] });
    expect(V.ok, JSON.stringify(failure(V))).toBe(true);
    expect(R.files['data/sine_09b5.bin']).toEqual(A.mem.slice(0x09b5, 0x0ab5));
    expect(src(R)).toMatch(/sine_09b5:\n\s+\.import binary "data\/sine_09b5\.bin"\s+\/\/ 256 bytes · Curve table/);
    // never in bin/: the Sublime Text Kick Assembler package empties that output folder before each build
    expect(Object.keys(R.files).filter(f => f.startsWith('bin/'))).toEqual([]);
    expect(R.lines.find(l => l.k === 'hdr' && l.a === 0x09b5)).toMatchObject({ binary: 'data/sine_09b5.bin', text: expect.stringContaining('· data/sine_09b5.bin') });
  });

  it('keeps the labels inside a binary code block defined for the code that uses them', () => {
    const code = findBlock(A0.blocks, 0x0866)!;
    const inner = [...A0.labels.keys()].filter(a => a > code.start && a < code.end);
    expect(inner.length).toBeGreaterThan(2);
    const { R, V } = roundTrip({ ...demoInput(), binary: [code.start] });
    expect(V.ok, JSON.stringify(failure(V))).toBe(true);
    // a .label for each label the rest of the file refers to; one used only inside the block itself needs none
    const usedOutside = (a: number) => (A0.xrefs.get(a) ?? []).some(x => x.from < code.start || x.from >= code.end);
    expect(inner.some(a => !usedOutside(a))).toBe(true);
    for (const a of inner) {
      const def = `.label ${R.labels.get(a)!.name} = $${h4(a)}`;
      if (usedOutside(a)) expect(src(R)).toContain(def); else expect(src(R)).not.toContain(def);
    }
    expect(src(R)).toContain('jsr sub_0866');
  });

  it('names an unlabelled block after its address, and works with a block left out of the build', () => {
    const fill = A0.blocks.find(b => b.type === 'fill' && !A0.labels.has(b.start))!;
    const r1 = roundTrip({ ...demoInput(), binary: [fill.start] });
    expect(r1.V.ok).toBe(true);
    expect(Object.keys(r1.R.files)).toContain(`data/block_${h4(fill.start)}.bin`);
    const code = findBlock(A0.blocks, 0x0866)!;
    const both = roundTrip({ ...demoInput(), binary: [code.start, 0x09b5], excluded: [code.start] });
    expect(both.V.ok, JSON.stringify(failure(both.V))).toBe(true);
    // the #else branch defines the labels inside the left-out binary block too
    const elseBranch = src(both.R).split('#else')[1].split('#endif')[0];
    expect(elseBranch).toContain('.label sub_0866 = $0866');
  });

  it('saves music as raw bytes instead of a .sid (and refers to it by label)', () => {
    const { R, V } = roundTrip({ ...demoInput(), binary: [0x1000] });
    expect(V.ok, JSON.stringify(failure(V))).toBe(true);
    expect(Object.keys(R.files)).toContain(`data/${R.labels.get(0x1000)?.name ?? 'block_1000'}.bin`);
    expect(Object.keys(R.files)).not.toContain('music/music_1000.sid');
    expect(src(R)).not.toMatch(/LoadSid|music\.(init|play)/);
  });

  it('defines only the labels inside the block that the source uses (not I/O registers the code reaches by name)', () => {
    // one big user block over $c000-$dfff, as a memory dump over the I/O area gets: the analysis labels $d011, $d020
    // and $d021 inside it, but the code writes them as VIC registers, so only $c003 and $c005 need a .label
    const f = fromSource('big.prg', '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n lda #$1b\n sta $d011\n lda #$00\n sta $d020\n sta $d021\n lda $c003\n sta $c005\n rts\n.pc = $c000\n .byte 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16\n.pc = $dfff\n .byte $55');
    const p: ProjectInput = { name: 'big', files: [f], overrides: [{ start: 0xc000, end: 0xe000, type: 'charset' }], binary: [0xc000] };
    const { R, V } = roundTrip(p);
    expect(V.ok, JSON.stringify(failure(V))).toBe(true);
    const text = R.files['big.asm'] as string;
    expect(text).toContain('sta VIC_SCREEN_CTRL1');
    expect(text.split('\n').filter(l => l.startsWith('.label charset_')).map(l => l.trim())).toEqual(['.label charset_c003 = $c003', '.label charset_c005 = $c005']);
  });

  it('makes no labels in a block over the I/O area for the registers the code writes, only for the RAM it reaches', () => {
    // the same dump written in the source (not binary): $d011/$d020/$d021 with I/O banked in are registers, so no
    // `charset_d020:` lines split the block; $d800 written with $01 = $34 is the RAM below, and keeps its label
    const f = fromSource('big.prg', '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n lda #$1b\n sta $d011\n lda #$00\n sta $d020\n sta $d021\n lda $c003\n sei\n lda #$34\n sta $01\n lda #$01\n sta $d800\n lda #$37\n sta $01\n cli\n rts\n.pc = $c000\n .byte 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16\n.pc = $dfff\n .byte $55');
    for (const [settings, border] of [[{}, 'sta VIC_BORDER_COLOR'], [{ hwInclude: 'none' as const }, 'sta $d020']] as const) {
      const { R, V } = roundTrip({ name: 'big', files: [f], overrides: [{ start: 0xc000, end: 0xe000, type: 'charset' }], settings });
      expect(V.ok, JSON.stringify(failure(V))).toBe(true);
      const text = R.files['big.asm'] as string;
      expect(text).toContain(border);
      expect([...R.labels.keys()].filter(a => a >= 0xd000 && a < 0xe000)).toEqual([0xd800]);
      expect(text.split('\n').filter(l => /^charset_[0-9a-f]{4}:/.test(l))).toEqual(['charset_c000:', 'charset_c003:', 'charset_d800:']);
      expect(text).toMatch(/sta charset_d800\b/);
    }
  });

  it('warns when bank tracking is off and the I/O the code reaches is written as labels', () => {
    const f = fromSource('big.prg', '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n lda #$1b\n sta $d011\n lda #$00\n sta $d020\n sta $d021\n lda $c003\n rts\n.pc = $c000\n .byte 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16\n.pc = $dfff\n .byte $55');
    const p = (bankTracking: boolean): ProjectInput => ({ name: 'big', files: [f], overrides: [{ start: 0xc000, end: 0xe000, type: 'charset' }], settings: { bankTracking } });
    const off = roundTrip(p(false));
    expect(off.V.ok, JSON.stringify(failure(off.V))).toBe(true);
    expect(off.R.files['big.asm']).toContain('sta charset_d020');
    const warn = off.A.log.filter(l => l.cat === 'banks');
    expect(warn).toEqual([{ lvl: 'warn', cat: 'banks', addr: 0xd011, msg: expect.stringContaining('Bank tracking is off, so the code\'s accesses to 3 I/O addresses inside the loaded bytes are written as labels ($d011 charset_d011, $d020 charset_d020, $d021 charset_d021). Turn on Settings → Analysis → Follow the memory configuration') }]);
    // with it on the registers are named, and there is nothing to report; nor is there for code that only reaches RAM
    const on = roundTrip(p(true));
    expect(on.R.files['big.asm']).toContain('sta VIC_BORDER_COLOR');
    expect(on.A.log.filter(l => l.cat === 'banks')).toEqual([]);
    expect(roundTrip({ ...demoInput(), settings: { bankTracking: false } }).A.log.filter(l => l.cat === 'banks')).toEqual([]);
  });

  it('names the CPU vectors even when the file covers them, and keeps a real read of RAM under the KERNAL', () => {
    // a dump to $ffff: the code sets the IRQ vector, banks the KERNAL out and reads $eaa5 (RAM there now)
    const f = fromSource('dump.prg', '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n sei\n lda #<irq\n sta $fffe\n lda #>irq\n sta $ffff\n lda #$35\n sta $01\n lda $eaa5\n sta $d020\n cli\n jmp *\nirq:\n rti\n.pc = $e000\n .byte 1,2,3,4\n.pc = $ffff\n .byte 0');
    const base: ProjectInput = { name: 'dump', files: [f], overrides: [{ start: 0xe000, end: 0x10000, type: 'charset' }], binary: [0xe000] };
    for (const [settings, vector] of [[{}, 'sta IRQ_VECTOR'], [{ hwInclude: 'none' as const }, 'sta $fffe']] as const) {
      const { R, V } = roundTrip({ ...base, settings });
      expect(V.ok, JSON.stringify(failure(V))).toBe(true);
      const text = R.files['dump.asm'] as string;
      expect(text).toMatch(new RegExp(`${vector.replace('$', '\\$')}\\s+// Hardware IRQ/BRK vector`));
      expect(text).toMatch(/sta (IRQ_VECTOR\+1|\$ffff)\b/);
      expect(text).toContain('lda charset_eaa5');
      expect(text.split('\n').filter(l => l.startsWith('.label charset_')).map(l => l.trim())).toEqual(['.label charset_eaa5 = $eaa5']);
    }
  });

  it('is kept in the project file', () => {
    const p = { ...demoProject(), binary: [0x09b5, 0x1000] };
    expect(deserializeProject(JSON.parse(JSON.stringify(serializeProject(p)))).binary).toEqual([0x09b5, 0x1000]);
    expect(deserializeProject({ ...serializeProject(p), binary: undefined }).binary).toEqual([]);
  });
});

describe('hardware symbols as raw addresses', () => {
  const line = (R: ReturnType<typeof render>, text: string) => R.lines.find(l => lineText(l, DEFAULT_SETTINGS).trimStart().startsWith(text));

  it('writes the address with the register\'s description, no #import and no include file', () => {
    const named = roundTrip(demoInput());
    const raw = roundTrip({ ...demoInput(), settings: { hwInclude: 'none' } });
    expect(raw.V.ok, JSON.stringify(failure(raw.V))).toBe(true);
    expect(line(named.R, 'sta VIC_BORDER_COLOR')).toMatchObject({ cmt: 'Border color' });
    expect(line(raw.R, 'sta $d020')).toMatchObject({ cmt: 'Border color' });
    expect(line(raw.R, 'jsr $ffd2')).toMatchObject({ cmt: expect.stringMatching(/^Output character/) });
    const src = raw.R.files['raster-demo.asm'] as string;
    expect(src).not.toContain('#import');
    expect(src).not.toMatch(/\bVIC_|\bCHROUT\b/);
    expect(Object.keys(raw.R.files)).not.toContain('include/c64-hardware.asm');
    expect(Object.keys(named.R.files)).toContain('include/c64-hardware.asm');
    expect(exportFiles(demoInput() as Project, raw.R, { ...DEFAULT_SETTINGS, hwInclude: 'none' }, raw.V)['README.md']).not.toContain('c64-hardware');
  });

  it('keeps the comment off with hardware comments off', () => {
    const raw = roundTrip({ ...demoInput(), settings: { hwInclude: 'none', hwComments: false } });
    expect((line(raw.R, 'sta $d020') as { cmt?: string }).cmt ?? '').not.toContain('Border color');
  });
});

describe('merging a range into one block', () => {
  const base = demoInput();
  const A0 = analyze(base);
  const apply = (m: ReturnType<typeof mergeRange>, extra: ProjectInput['overrides'] = []) => {
    if ('error' in m) throw new Error(m.error);
    const r = roundTrip({ ...base, overrides: [...extra, m.override] });
    expect(r.V.ok, JSON.stringify(failure(r.V))).toBe(true);
    return r.A;
  };

  it('replaces every block inside the range with one block of the type it is given', () => {
    const m = mergeRange(A0, 0x0939, 0x0ab5, 'bytes');
    if ('error' in m) throw new Error(m.error);
    expect(m.replaced.map(b => b.start)).toEqual(A0.blocks.filter(b => b.start >= 0x0939 && b.end <= 0x0ab5).map(b => b.start));
    expect(m.replaced.length).toBeGreaterThan(3);
    expect(m.cut).toEqual([]);
    expect(m.override).toEqual({ start: 0x0939, end: 0x0ab5, type: 'data' });
    const A = apply(m);
    expect(findBlock(A.blocks, 0x0939)).toMatchObject({ start: 0x0939, end: 0x0ab5, type: 'data', user: true });
  });

  it('keeps the part of a block outside the range as it was', () => {
    // txt_0960 ($0960-$0984) is cut at $0970: $0949-$096f becomes one text block, $0970-$0984 stays text
    const m = mergeRange(A0, 0x0949, 0x0970, 'text', findBlock(A0.blocks, 0x0949));
    if ('error' in m) throw new Error(m.error);
    expect(m.cut.map(b => [b.start, b.end])).toEqual([[0x0960, 0x0985]]);
    expect(m.override).toEqual({ start: 0x0949, end: 0x0970, type: 'text', props: { enc: 'petscii' } });
    const A = apply(m);
    expect(findBlock(A.blocks, 0x0949)).toMatchObject({ start: 0x0949, end: 0x0970, type: 'text' });
    expect(findBlock(A.blocks, 0x0975)).toMatchObject({ start: 0x0970, type: 'text' });
  });

  it('takes the number format, row length and table kind from the block it starts in when the type is the same', () => {
    const fmt = { start: 0x09b5, end: 0x09c5, type: 'data' as const, props: { fmt: 'bin' as const, row: 2 } };
    const A1 = analyze({ ...base, overrides: [fmt] });
    const from = findBlock(A1.blocks, 0x09b5)!;
    const m = mergeRange(A1, 0x09b5, 0x0a00, 'bytes', from);
    expect(m).toMatchObject({ override: { start: 0x09b5, end: 0x0a00, type: 'data', props: { fmt: 'bin', row: 2 } } });
    apply(m, [fmt]);
    // another type gets its own defaults
    expect(mergeRange(A1, 0x09b5, 0x0a00, 'words', from)).toMatchObject({ override: { type: 'words' } });
    expect('props' in (mergeRange(A1, 0x09b5, 0x0a00, 'words', from) as { override: object }).override).toBe(false);
    const colors = findBlock(A0.blocks, 0x0939)!;
    expect(mergeRange(A0, 0x0939, 0x0960, markIdOf(colors), colors)).toMatchObject({ override: { type: 'table', props: { sub: 'colors' } } });
  });

  it('refuses ranges outside the file, across files or backwards', () => {
    expect(mergeRange(A0, 0x0960, 0x0960, 'bytes')).toEqual({ error: 'the end must come after the start' });
    expect(mergeRange(A0, 0x9000, 0x9010, 'bytes')).toEqual({ error: '$9000 is not part of any loaded file' });
    expect(mergeRange(A0, 0x37f0, 0x3810, 'bytes')).toEqual({ error: '$37f0-$380f runs past the end of the file at $3800' });
    expect(mergeRange(A0, 0x0960, 0x0970, 'nope')).toEqual({ error: 'unknown block type "nope"' });
    const two = analyze({ name: 't', files: [{ name: 'a.prg', load: 0x1000, bytes: new Uint8Array(16) }, { name: 'b.prg', load: 0x1010, bytes: new Uint8Array(16) }] });
    expect(mergeRange(two, 0x1008, 0x1018, 'bytes')).toEqual({ error: '$1008-$1017 crosses into another file at $1010' });
  });

  it('names a block\'s type the way the Type list does', () => {
    expect(markIdOf({ type: 'text', props: { enc: 'screen' } })).toBe('textsc');
    expect(markIdOf({ type: 'text', props: {} })).toBe('text');
    expect(markIdOf({ type: 'lohi', props: {} })).toBe('bytes');
    expect(markIdOf({ type: 'data', props: {} })).toBe('bytes');
    expect(markIdOf({ type: 'code', props: {} })).toBe('code');
  });
});

describe('comment lines and blocks (notes)', () => {
  const base = demoInput();
  const A0 = analyze(base);
  // an operand byte: the note goes above the instruction holding it
  const operand = [...A0.codeOwner.keys()].find(a => a > 0x0810 && A0.codeOwner[a] >= 0)!;
  const notes = {
    0x0810: { text: 'set up the raster IRQ' },
    0x09c1: { text: 'second half\nof the */ curve', block: true },
    0x0950: { text: 'inside the text' },
    [operand]: { text: 'operand', block: true },
    0x9000: { text: 'not loaded' },
    0x0a00: { text: '' },
  };
  const p = { ...base, notes, blockComments: { 0x0939: 'colors\n\nfor the border  ' }, comments: { 0x0939: 'one\nline' } };
  const { R, V } = roundTrip(p);
  const src = R.files['raster-demo.asm'] as string;
  const lines = R.fileLines['raster-demo.asm'];
  const noteAt = (a: number) => lines.filter(l => l.k === 'cmt' && l.note && l.a === a).map(l => l.k === 'cmt' && l.text);
  /** the first line after the note's own lines */
  const after = (a: number) => { const i = lines.findIndex(l => l.k === 'cmt' && l.note && l.a === a); let j = i; while (lines[j].k === 'cmt' && (lines[j] as { note?: boolean }).note) j++; return lines[j]; };

  it('still re-assembles byte-identical', () => {
    expect(V.ok, JSON.stringify(failure(V))).toBe(true);
  });

  it('writes a comment line above the label of its address', () => {
    expect(src).toContain('// set up the raster IRQ\nstart:\n');
    expect(after(0x0810)).toMatchObject({ k: 'lbl', a: 0x0810, name: 'start' });
  });

  it('writes a block comment, breaking the .byte row at its address', () => {
    expect(noteAt(0x09c1)).toEqual(['/*', 'second half', 'of the * / curve', '*/']);
    expect(src).toContain('/*\nsecond half\nof the * / curve\n*/\n');
    expect(after(0x09c1)).toMatchObject({ k: 'dat', a: 0x09c1, dir: '.byte' });
  });

  it('breaks a .text row at its address', () => {
    expect(after(0x0950)).toMatchObject({ k: 'dat', a: 0x0950 });
    expect(noteAt(0x0950)).toEqual(['inside the text']);
  });

  it('puts a note on an operand byte above the instruction holding it', () => {
    const ins = A0.codeOwner[operand];
    const next = after(operand);
    expect(next.a).toBe(ins);
    expect(next.k === 'lbl' || next.k === 'ins').toBe(true);
  });

  it('ignores notes outside the loaded files and empty ones', () => {
    expect(src).not.toContain('not loaded');
    expect(noteAt(0x0a00)).toEqual([]);
  });

  it('splits a block comment with line breaks into // lines and joins a line comment', () => {
    expect(src).toContain('// colors\n//\n// for the border\n');
    expect(src).toMatch(/\/\/ one line\n/);
  });
});

describe('build scripts edited by the user', () => {
  it('are exported instead of the generated ones, the other one stays generated, and they are kept in the project file', () => {
    const own = '@echo off\r\nrem my own build\r\njava -jar C:\\tools\\KickAss.jar raster-demo.asm\r\n';
    const p = { ...demoProject(), scripts: { 'build.bat': own } };
    const { R } = roundTrip(demoInput());
    const S = { ...DEFAULT_SETTINGS };
    const out = exportFiles(p, R, S);
    expect(out['build.bat']).toBe(own);
    expect(out['build.sh']).toBe(buildScripts(S, R.fileNames)['build.sh']);
    expect(projectScripts({}, S, R.fileNames)).toEqual(buildScripts(S, R.fileNames));
    expect(deserializeProject(JSON.parse(JSON.stringify(serializeProject(p)))).scripts).toEqual({ 'build.bat': own });
    expect(deserializeProject({ ...serializeProject(p), scripts: undefined }).scripts).toEqual({});
  });
});

describe('bookmarks', () => {
  const bookmarks = { 0x0810: { title: 'init', text: 'clears the screen\nthen the raster IRQ' }, 0x09b5: { title: 'scroll text', text: '' } };

  it('are kept in the project file, and older files have none', () => {
    const p = { ...demoProject(), bookmarks };
    expect(deserializeProject(JSON.parse(JSON.stringify(serializeProject(p)))).bookmarks).toEqual(bookmarks);
    expect(deserializeProject({ ...serializeProject(p), bookmarks: undefined }).bookmarks).toEqual({});
    expect(demoProject().bookmarks).toEqual({});
  });

  it('never reach the generated source', () => {
    const plain = roundTrip(demoInput()), marked = roundTrip({ ...demoInput(), bookmarks });
    expect(marked.V.ok).toBe(true);
    expect(Object.values(marked.R.files)).toEqual(Object.values(plain.R.files));
  });
});

describe('project helpers', () => {
  it('demoProject() builds a complete Project', () => {
    const p = demoProject();
    expect(p.format).toBe('kickreasm-project');
    expect(p.files[0].id).toBeTruthy();
    expect(p.settings.indent).toBe(8);
  });

  it('PSID files survive makePsid -> parsePsid', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const sid = parsePsid(makePsid(data, 0x1000, 0x1000, 0x1003, 'tune'));
    expect(sid).toMatchObject({ location: 0x1000, init: 0x1000, play: 0x1003, size: 5, name: 'tune' });
    expect([...sid.data]).toEqual([1, 2, 3, 4, 5]);
  });

  it('validates labels like the UI', () => {
    expect(validLabel('irq_top')).toBe(true);
    expect(validLabel('lda')).toBe(false);
    expect(validLabel('9lives')).toBe(false);
    expect(validLabel('a-b')).toBe(false);
  });
});
