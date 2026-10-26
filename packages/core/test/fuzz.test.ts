/* Property: whatever the program, overrides, entries, labels, comments, comment lines/blocks and settings,
 * the generated Kick Assembler source re-assembles byte-identical. */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { analyze, h4, render, verify, type NumberFormat, type Override, type ProjectInput, type Settings, type TextEncoding } from '../src';
import { describeProject, loadFor, OVERRIDE_TYPES, randomPrg } from './helpers/programs';

const RUNS = Number(process.env.FUZZ_RUNS) || 300;

const settingsArb: fc.Arbitrary<Partial<Settings>> = fc.record({
  illegal: fc.boolean(), detectMusic: fc.boolean(), detectGfx: fc.boolean(), detectText: fc.boolean(),
  mnemonicCase: fc.constantFrom('lower', 'upper'), hexCase: fc.constantFrom('lower', 'upper'),
  bytesPerRow: fc.constantFrom(4, 8, 16), indent: fc.constantFrom(2, 4, 8), commentCol: fc.constantFrom(32, 40, 48),
  basicUpstart: fc.boolean(), hwInclude: fc.constantFrom('import', 'inline', 'none'), hwComments: fc.boolean(),
  musicAsSid: fc.boolean(), gfxBinary: fc.boolean(), addrComments: fc.boolean(), bankTracking: fc.boolean(), codeIslands: fc.boolean(),
}, { requiredKeys: [] }) as fc.Arbitrary<Partial<Settings>>;

const overrideArb = fc.record({
  at: fc.nat(), size: fc.integer({ min: 1, max: 400 }), type: fc.constantFrom(...OVERRIDE_TYPES),
  enc: fc.constantFrom(undefined, 'petscii', 'screen', 'petscii-mixed', 'screen-mixed'), fmt: fc.constantFrom(undefined, 'hex', 'bin', 'dec'), row: fc.option(fc.integer({ min: 1, max: 40 }), { nil: undefined }),
});

/** Comment text the UI could produce (single line), including characters that look like syntax. */
const commentArb = fc.stringOf(fc.constantFrom(...'abc XYZ09_-"/*;:#$%()<>,.'.split('')), { minLength: 1, maxLength: 24 });
/** Multi-line text (the inspector's block comment, comment lines and blocks), empty lines included. */
const multiLineArb = fc.array(fc.oneof(commentArb, fc.constant(''), fc.constant('*/ end')), { minLength: 1, maxLength: 3 }).map(ls => ls.join('\n'));

const programArb = fc.record({
  seed: fc.integer(),
  kind: fc.constantFrom('basic', 'c000', 'random') as fc.Arbitrary<'basic' | 'c000' | 'random'>,
  randomLoad: fc.integer({ min: 0, max: 0xf000 }),
  len: fc.integer({ min: 200, max: 3200 }),
  overrides: fc.array(overrideArb, { maxLength: 4 }),
  entries: fc.array(fc.nat(), { maxLength: 3 }),
  entryPoint: fc.option(fc.nat(), { nil: undefined }),
  renameEvery: fc.option(fc.integer({ min: 1, max: 7 }), { nil: undefined }),
  /** leave every n-th block (from an offset) out of the build */
  exclude: fc.option(fc.tuple(fc.integer({ min: 2, max: 6 }), fc.nat()), { nil: undefined }),
  /** save every n-th block (from an offset) as a binary file loaded with .import binary */
  binary: fc.option(fc.tuple(fc.integer({ min: 2, max: 5 }), fc.nat()), { nil: undefined }),
  comments: fc.array(fc.tuple(fc.nat(), commentArb), { maxLength: 6 }),
  blockComment: fc.option(multiLineArb, { nil: undefined }),
  notes: fc.array(fc.tuple(fc.nat(), multiLineArb, fc.boolean()), { maxLength: 4 }),
  bankZones: fc.array(fc.record({
    at: fc.nat(), size: fc.integer({ min: 1, max: 600 }),
    port: fc.option(fc.integer({ min: 0x30, max: 0x37 }), { nil: undefined }), vicBank: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }),
  }), { maxLength: 3 }),
  settings: settingsArb,
});

type ProgramSpec = typeof programArb extends fc.Arbitrary<infer U> ? U : never;

function buildProject(spec: ProgramSpec): ProjectInput {
  const load = loadFor(spec.kind, spec.randomLoad);
  const len = Math.min(spec.len, 0x10000 - load);
  const file = randomPrg(spec.seed, load, len);
  const at = (n: number) => load + (n % len);
  const overrides: Override[] = spec.overrides.map(o => {
    const start = at(o.at);
    const props: Override['props'] = o.type === 'text' && o.enc ? { enc: o.enc as TextEncoding } : o.type === 'data' && (o.fmt || o.row) ? { fmt: o.fmt as NumberFormat | undefined, row: o.row } : undefined;
    return { start, end: Math.min(load + len, start + o.size), type: o.type, ...(props ? { props } : {}) };
  });
  const comments: Record<number, string> = {};
  for (const [n, text] of spec.comments) comments[at(n)] = text;
  return {
    name: 'fuzz', files: [file], overrides, entries: spec.entries.map(at), entryPoint: spec.entryPoint == null ? null : at(spec.entryPoint), labels: {}, comments,
    blockComments: spec.blockComment ? { [load]: spec.blockComment } : {}, settings: spec.settings,
    notes: Object.fromEntries(spec.notes.map(([n, text, block]) => [at(n), block ? { text, block } : { text }])),
    bankZones: spec.bankZones.map(z => ({ start: at(z.at), end: at(z.at) + z.size, port: z.port, vicBank: z.vicBank })),
  };
}

function check(p: ProjectInput, renameEvery?: number, exclude?: [number, number], binary?: [number, number]) {
  let A = analyze(p);
  if (renameEvery) {
    // rename like the UI does: existing labels get new unique names
    const labels: Record<number, string> = {};
    let i = 0;
    for (const [a] of A.labels) if (i++ % renameEvery === 0) labels[a] = `user_${h4(a)}`;
    // zero-page variables too (a pointer's high byte must follow its low byte)
    for (const [a, z] of A.zp) if (!z.off && i++ % renameEvery === 0) labels[a] = `uzp_${h4(a)}`;
    p = { ...p, labels };
    A = analyze(p);
  }
  // excluding blocks changes only the output, not the analysis
  if (exclude) p = { ...p, excluded: A.blocks.filter((_b, i) => (i + exclude[1]) % exclude[0] === 0).map(b => b.start) };
  // so does saving blocks as binary files (some of them excluded as well)
  if (binary) p = { ...p, binary: A.blocks.filter((_b, i) => (i + binary[1]) % binary[0] === 0).map(b => b.start) };
  const R = render(A, p);
  const V = verify(A, R);
  if (!V.ok) {
    const r = V.results.find(x => !x.ok)!;
    throw new Error(`round-trip failed for ${describeProject(p)}\nerrors: ${JSON.stringify(r.errors.slice(0, 3))}\ndiffs: ${JSON.stringify(r.diffs.slice(0, 3))}`);
  }
}

describe('fuzz: random PRGs, overrides and settings always round-trip', () => {
  it(`holds for ${RUNS} generated projects`, () => {
    fc.assert(fc.property(programArb, spec => check(buildProject(spec), spec.renameEvery, spec.exclude, spec.binary)), { numRuns: RUNS });
  });

  it('holds for two-file projects', () => {
    // Overlapping files cannot both round-trip (spec 8.1: the later file wins, with a warning),
    // so the second file is placed after the first.
    fc.assert(fc.property(programArb, fc.integer({ min: 200, max: 2000 }), fc.integer(), fc.nat(0x400), (a, len2, seed2, gap) => {
      const p = buildProject({ ...a, kind: a.kind === 'random' ? 'c000' : a.kind });
      const f = p.files[0];
      const load2 = f.load + f.bytes.length + gap;
      if (load2 + len2 > 0x10000) return;
      const second = randomPrg(seed2, load2, len2, 'second.prg');
      check({ ...p, files: [f, second] }, a.renameEvery);
    }), { numRuns: Math.max(20, Math.floor(RUNS / 6)) });
  });

  it('reports a failing round-trip (sanity check of the harness)', () => {
    const p = buildProject({ seed: 1, kind: 'basic', randomLoad: 0, len: 300, overrides: [], entries: [], entryPoint: undefined, renameEvery: undefined, exclude: undefined, binary: undefined, comments: [], blockComment: undefined, notes: [], bankZones: [], settings: {} });
    const A = analyze(p);
    const R = render(A, p);
    const path = `${R.fileNames[0]}.asm`;
    const broken = { ...R, files: { ...R.files, [path]: (R.files[path] as string).replace(/\.byte \$([0-9a-f]{2})/, '.byte $ff') } };
    expect(verify(A, broken).ok).toBe(false);
  });
});
