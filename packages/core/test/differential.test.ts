/* The TypeScript engine must behave exactly like the prototype engine it was ported from
 * (plus the documented patches in helpers/reference.ts). Compares analysis, line model,
 * generated files and verification on the demo and on many random programs. */
import { describe, expect, it } from 'vitest';
import { analyze, makeDemo, OPC, parsePrg, render, verify, type AnalysisResult, type ProjectInput, type RenderResult } from '../src';
import { DEVIATIONS, loadReference } from './helpers/reference';
import { allOpcodesProgram, describeProject, rng, seededProject, SETTING_VARIANTS, zeroPageProgram } from './helpers/programs';

const KR = loadReference();

const isTiming = (msg: string) => msg.startsWith('Analysis finished in ');
const blockView = (b: Omit<AnalysisResult['blocks'][number], 'type'>, kind: string) =>
  ({ id: b.id, start: b.start, end: b.end, type: kind, file: b.file, props: b.props, conf: b.conf, reason: b.reason, user: b.user, entropy: b.entropy, hint: b.hint });
const setToArr = <T,>(s: Set<T>) => [...s];

/** Fast structural equality via a canonical JSON form; only builds a full diff when they differ. */
const canon = (v: unknown) => JSON.stringify(v, (_k, x) =>
  x instanceof Map ? { map: [...x] } : x instanceof Set ? { set: [...x] } : ArrayBuffer.isView(x) ? { bytes: Buffer.from((x as Uint8Array).buffer, (x as Uint8Array).byteOffset, (x as Uint8Array).byteLength).toString('hex') } : x);
function same(actual: unknown, expected: unknown, what: string) {
  if (canon(actual) !== canon(expected)) expect(actual, what).toEqual(expected);
}

function compare(p: ProjectInput) {
  const where = describeProject(p);
  // both engines get their own copy of the input
  const clone = (): ProjectInput => ({ ...p, files: p.files.map(f => ({ ...f, bytes: f.bytes.slice() })) });

  // following $01 and the VIC bank, and decoding code islands, are new in the production engine (the prototype has
  // no such passes): off here
  const A = analyze({ ...clone(), settings: { ...p.settings, bankTracking: false, codeIslands: false } });
  const refInput = clone();
  const RA = KR.analyze(refInput);

  same(A.log.filter(l => !isTiming(l.msg)), RA.log.filter((l: { msg: string }) => !isTiming(l.msg)), `log: ${where}`);
  same(A.blocks.map(b => blockView(b, b.type)), RA.blocks.map((b: Omit<AnalysisResult['blocks'][number], 'type'> & { type: number }) => blockView(b, KR.TYPE_INFO[b.type].key)), `blocks: ${where}`);
  same(A.tm, RA.tm, `type map: ${where}`);
  same(A.insLen, RA.insLen, 'insLen');
  same(A.codeOwner, RA.codeOwner, 'codeOwner');
  same([...A.labels], [...RA.labels], 'labels');
  same([...A.zp], [...RA.zp], 'zp');
  same([...A.xrefs], [...RA.xrefs], 'xrefs');
  same([...A.entryKind], [...RA.entryKind], 'entryKind');
  same([...A.hints], [...RA.hints], 'hints');
  same([...A.smc], [...RA.smc], 'smc');
  same([...A.lohiTabs], [...RA.lohiTabs], 'lohiTabs');
  same(A.music, RA.music, 'music');
  same({ ...A.vic, banks: setToArr(A.vic.banks), d018: setToArr(A.vic.d018) }, { ...RA.vic, banks: setToArr(RA.vic.banks), d018: setToArr(RA.vic.d018) }, 'vic evidence');
  same({ ...A.stats, ms: 0 }, { ...RA.stats, ms: 0 }, 'stats');
  expect(A.entry).toBe(RA.entry);

  const R: RenderResult = render(A, clone());
  const RR = KR.render(RA, refInput);
  same(R.files, RR.files, `files: ${where}`);
  same(R.lines, RR.lines, `lines: ${where}`);
  same([...R.labels], [...RR.labels], 'render labels');
  same(R.fileNames, RR.fileNames, 'file names');
  same(R.problems, RR.problems, 'render problems');

  const V = verify(A, R);
  const RV = KR.verify(RA, RR);
  expect(V.ok, `verify: ${where}`).toBe(RV.ok);
  // `excluded` (bytes of blocks left out of the build) is new in the production engine and always 0 here
  same(V.results.map(({ excluded: _x, ...r }) => r), RV.results, `verify results: ${where}`);
  return V.ok;
}

const demo = (): ProjectInput => { const d = makeDemo(); return { name: 'raster-demo', files: [parsePrg(d.name, d.prg)], overrides: [], labels: {}, comments: {}, settings: {} }; };

describe('differential: TypeScript engine == prototype engine', () => {
  it('documents its deliberate deviations', () => {
    expect(DEVIATIONS.length).toBe(20);
  });

  it('has a comparison that notices differences', () => {
    expect(() => same(new Uint8Array([1, 2]), new Uint8Array([1, 3]), 'bytes')).toThrow();
    expect(() => same(new Map([[1, 'a']]), new Map([[1, 'b']]), 'map')).toThrow();
    expect(() => same(new Set([1]), new Set([1]), 'set')).not.toThrow();
  });

  it('builds the same demo PRG', () => {
    expect(makeDemo().prg).toEqual(KR.makeDemo().prg);
  });

  it('matches on the demo under every setting variant', () => {
    for (const settings of SETTING_VARIANTS) expect(compare({ ...demo(), settings })).toBe(true);
  });

  it('matches on the demo with overrides, entries, labels and comments', () => {
    const base = demo();
    compare({ ...base, overrides: [{ start: 0x0a00, end: 0x0b00, type: 'code' }, { start: 0x1000, end: 0x1100, type: 'auto' }, { start: 0x2000, end: 0x2040, type: 'data', props: { fmt: 'bin', row: 3 } }], entries: [0x0c00], labels: { 0x0810: 'main', 0x00fb: 'zp_ptr' }, comments: { 0x0813: 'screen set up' }, blockComments: { 0x0810: 'entry point' } });
    // line breaks in block and line comments
    expect(compare({ ...base, comments: { 0x0813: 'two\nlines' }, blockComments: { 0x0810: 'entry point\n\n  second line  ', 0x2000: 'sprites\r\nhere' } })).toBe(true);
  });

  it('matches on synthetic opcode and zero-page programs', () => {
    expect(compare({ name: 'opcodes', files: [allOpcodesProgram(OPC)] })).toBe(true);
    expect(compare({ name: 'zp', files: [zeroPageProgram()] })).toBe(true);
  });

  it('matches on 150 seeded random programs (prototype fuzz recipe)', () => {
    for (let seed = 1; seed <= 150; seed++) compare(seededProject(seed));
  });

  it('matches on random programs with every override kind, entries and two files', () => {
    const kinds = ['code', 'data', 'text', 'words', 'sprite', 'fill', 'music', 'charset', 'bitmap', 'screen', 'table', 'lohi', 'auto'] as const;
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed * 31);
      const p = seededProject(1000 + seed);
      const f = p.files[0];
      const pick = () => f.load + Math.floor(r() * f.bytes.length);
      p.overrides = Array.from({ length: 1 + Math.floor(r() * 3) }, () => { const s = pick(); return { start: s, end: Math.min(f.load + f.bytes.length, s + 1 + Math.floor(r() * 200)), type: kinds[Math.floor(r() * kinds.length)] }; });
      p.entries = r() < 0.5 ? [pick()] : [];
      if (seed % 4 === 0) p.files = [...p.files, seededProject(2000 + seed).files[0]].map((x, i) => ({ ...x, name: `part${i}.prg` }));
      compare(p);
    }
  });
});
