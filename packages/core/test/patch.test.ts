/* Patches (spec 10.2): code written over a range of the loaded bytes, assembled at its start with the program's
 * names at hand, kept with the bytes it wrote over, and exported as PRG files of their own. */
import { describe, expect, it } from 'vitest';
import {
  analyze, createProject, deserializeProject, exportFiles, lineText, makePrg, patchEnd, patchFileName, planPatch, render, serializeProject,
  assemble, patchSource, switchPatch, unpatchedFiles, verify, withoutPatch, withPatch, type PatchRequest, type Project,
} from '../src';
import { fromSource } from './helpers/programs';

// 10 SYS2061: lda #0 / sta $d020 / sta $d021 / ldx #5 / loop: dex / bne loop / rts
const SRC = '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n lda #$00\n sta $d020\n sta $d021\n ldx #$05\nloop:\n dex\n bne loop\n rts';
const ORIGINAL = [0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x8d, 0x21, 0xd0, 0xa2, 0x05, 0xca, 0xd0, 0xfd, 0x60];

const project = (): Project => ({ ...createProject({ files: [fromSource('fix.prg', SRC)] }), labels: { [0x0817]: 'loop' } });
const ctx = (p: Project) => { const A = analyze(p); return { A, R: render(A, p) }; };
const plan = (p: Project, req: Partial<PatchRequest> & Pick<PatchRequest, 'start' | 'end' | 'source'>) => {
  const { A, R } = ctx(p);
  return planPatch(A, R, p, { name: 'fix', fill: 'nop', over: false, ...req });
};
const ok = (r: ReturnType<typeof plan>) => { if ('error' in r) throw new Error(r.error); return r; };
const bytesAt = (p: Project, a: number, n: number) => [...p.files[0].bytes.subarray(a - p.files[0].load, a - p.files[0].load + n)];
/** a patch's .asm assembled on its own (no other file), as its PRG */
const assembleAlone = (src: string) => { const r = assemble({ 'patch.asm': src }, 'patch.asm'); expect(r.errors).toEqual([]); return r.prg!; };

describe('patches', () => {
  it('writes shorter code over the range and fills the rest with NOPs, or keeps the bytes there', () => {
    const p = project();
    const r = ok(plan(p, { start: 0x080d, end: 0x0815, source: '  lda #$02\n  sta $d020' }));
    expect([...r.patch.bytes]).toEqual([0xa9, 0x02, 0x8d, 0x20, 0xd0, 0xea, 0xea, 0xea]);
    expect([...r.patch.old]).toEqual(ORIGINAL.slice(0, 8));
    expect(r.code.length).toBe(5);
    expect(r.past).toBe(0);
    const kept = ok(plan(p, { start: 0x080d, end: 0x0815, source: '  lda #$02\n  sta $d020', fill: 'keep' }));
    expect([...kept.patch.bytes]).toEqual([0xa9, 0x02, 0x8d, 0x20, 0xd0]);
    // no code: the range becomes NOPs (nothing to keep otherwise)
    expect([...ok(plan(p, { start: 0x0815, end: 0x0817, source: '' })).patch.bytes]).toEqual([0xea, 0xea]);
    expect(plan(p, { start: 0x0815, end: 0x0817, source: '', fill: 'keep' })).toMatchObject({ error: expect.stringMatching(/Write the code/) });
  });

  it('does not write more than the original unless told to overwrite past the range', () => {
    const p = project();
    const long = '  lda #$02\n  sta $d020\n  sta $d021\n  nop';
    expect(plan(p, { start: 0x080d, end: 0x0815, source: long })).toMatchObject({ error: 'The code is 9 bytes, 1 more than the 8 of the original. Tick "Overwrite past the range" to write over the bytes after it.' });
    const r = ok(plan(p, { start: 0x080d, end: 0x0815, source: long, over: true }));
    expect(r.code.length).toBe(9);
    expect(r.past).toBe(1);
    expect(patchEnd(r.patch)).toBe(0x0816);
    expect([...r.patch.old]).toEqual(ORIGINAL.slice(0, 9));
    // never past the end of the file
    expect(plan(p, { start: 0x0819, end: 0x081b, source: '  jmp $1234', over: true })).toMatchObject({ error: 'The code runs past the end of the file at $081b.' });
    expect(plan(p, { start: 0x0819, end: 0x0820, source: '  nop' })).toMatchObject({ error: expect.stringMatching(/runs past the end of the file at \$081b/) });
  });

  it('knows the program\'s labels and the hardware symbols, and says which line is wrong', () => {
    const p = project();
    expect([...ok(plan(p, { start: 0x0815, end: 0x0818, source: '  jmp loop' })).patch.bytes]).toEqual([0x4c, 0x17, 0x08]);
    // the listing's own lines (names and all) give the bytes back
    const { R } = ctx(p);
    const lines = R.lines.filter(l => l.a >= 0x080d && l.a < 0x081b && (l.k === 'ins' || l.k === 'lbl')).map(l => lineText(l, p.settings));
    expect(lines.some(l => /sta [a-z_]/i.test(l))).toBe(true);
    expect([...ok(plan(p, { start: 0x080d, end: 0x081b, source: lines.join('\n') })).patch.bytes]).toEqual(ORIGINAL);
    // a label of its own wins over the program's
    expect([...ok(plan(p, { start: 0x0815, end: 0x081a, source: 'loop:\n  inx\n  bne loop\n  nop' })).patch.bytes]).toEqual([0xe8, 0xd0, 0xfd, 0xea, 0xea]);
    expect(plan(p, { start: 0x080d, end: 0x0815, source: '  lda #$02\n  sta nowhere' })).toMatchObject({ error: expect.stringMatching(/nowhere/) });
    expect(plan(p, { start: 0x080d, end: 0x0815, source: '  lda #$02\n  ldq #1' })).toMatchObject({ line: 2, error: expect.stringMatching(/^Line 2: /) });
    expect(plan(p, { start: 0x080d, end: 0x0815, source: '* = $1000\n  nop' })).toMatchObject({ error: expect.stringMatching(/must start at \$080d/) });
  });

  it('is written over the file and taken out again; it can be edited, and others are in the way', () => {
    let p = project();
    const a = ok(plan(p, { start: 0x080d, end: 0x0815, source: '  lda #$02\n  sta $d020' })).patch;
    p = { ...p, ...withPatch(p, a) };
    expect(bytesAt(p, 0x080d, 8)).toEqual([0xa9, 0x02, 0x8d, 0x20, 0xd0, 0xea, 0xea, 0xea]);
    expect(p.patches.map(x => x.name)).toEqual(['fix']);
    // over another patch: no; a name twice: no
    expect(plan(p, { name: 'other', start: 0x0812, end: 0x0817, source: '' })).toMatchObject({ error: 'It would write over the patch "fix" ($080d-$0814).' });
    expect(plan(p, { start: 0x0815, end: 0x0817, source: '' })).toMatchObject({ error: 'There is already a patch called "fix".' });
    // edited: written over the bytes it found, not over its own
    const e = ok(plan(p, { id: a.id, start: 0x080d, end: 0x0815, source: '  inc $d020' }));
    expect([...e.patch.old]).toEqual(ORIGINAL.slice(0, 8));
    p = { ...p, ...withPatch(p, e.patch) };
    expect(p.patches).toHaveLength(1);
    expect(bytesAt(p, 0x080d, 8)).toEqual([0xee, 0x20, 0xd0, 0xea, 0xea, 0xea, 0xea, 0xea]);
    const b = ok(plan(p, { name: 'wait', start: 0x0815, end: 0x0817, source: '  ldx #$0a' })).patch;
    p = { ...p, ...withPatch(p, b) };
    expect([...unpatchedFiles(p.files, p.patches)[0].bytes.subarray(12)]).toEqual(ORIGINAL);
    // removed: the bytes are back
    p = { ...p, ...withoutPatch(p, a.id) };
    expect(bytesAt(p, 0x080d, 10)).toEqual([...ORIGINAL.slice(0, 8), 0xa2, 0x0a]);
    p = { ...p, ...withoutPatch(p, b.id) };
    expect(bytesAt(p, 0x080d, 14)).toEqual(ORIGINAL);
    expect(p.patches).toEqual([]);
  });

  it('says where each line of the code goes and how long it is, also while there is an error', () => {
    const p = project();
    const r = ok(plan(p, { start: 0x080d, end: 0x0815, source: 'fix:\n  lda #$02    // red\n\n  sta $d020' }));
    expect(r.lines).toEqual([{ addr: 0x080d, len: 0 }, { addr: 0x080d, len: 2 }, { addr: 0x080f, len: 0 }, { addr: 0x080f, len: 3 }]);
    const long = plan(p, { start: 0x080d, end: 0x0815, source: '  lda #$02\n  sta $d020\n  sta $d021\n  nop' });
    expect(long).toMatchObject({ error: expect.stringMatching(/^The code is 9 bytes/), lines: [{ addr: 0x080d, len: 2 }, { addr: 0x080f, len: 3 }, { addr: 0x0812, len: 3 }, { addr: 0x0815, len: 1 }] });
    expect([...(long as { code: Uint8Array }).code]).toEqual([0xa9, 0x02, 0x8d, 0x20, 0xd0, 0x8d, 0x21, 0xd0, 0xea]);
    // a wrong line: the lines before it still have their place
    const bad = plan(p, { start: 0x080d, end: 0x0815, source: '  lda #$02\n  ldq #1\n  nop' });
    expect(bad).toMatchObject({ line: 2, lines: [{ addr: 0x080d, len: 2 }, expect.anything(), expect.anything()] });
  });

  it('is switched off and on: the bytes come and go, the range stays taken', () => {
    let p = project();
    const a = ok(plan(p, { name: 'red', start: 0x080d, end: 0x0815, source: '  lda #$02\n  sta $d020' })).patch;
    p = { ...p, ...withPatch(p, a) };
    p = { ...p, ...switchPatch(p, a.id, false) };
    expect(p.patches[0].off).toBe(true);
    expect(bytesAt(p, 0x080d, 14)).toEqual(ORIGINAL);
    expect(unpatchedFiles(p.files, p.patches)[0].bytes).toEqual(p.files[0].bytes);
    expect(plan(p, { name: 'other', start: 0x0810, end: 0x0812, source: '' })).toMatchObject({ error: 'It would write over the patch "red" ($080d-$0814, switched off).' });
    const { R } = ctx(p);
    expect(R.files['fix.asm']).not.toContain('==== patch');
    expect(exportFiles(p, R, p.settings)['README.md']).toContain('loads where it goes (switched off: not in the sources)');
    // edited while off: it stays off, written over the same bytes
    const e = ok(plan(p, { id: a.id, start: 0x080d, end: 0x0815, source: '  inc $d020' })).patch;
    expect(e.off).toBe(true);
    expect([...e.old]).toEqual(ORIGINAL.slice(0, 8));
    p = { ...p, ...withPatch(p, e) };
    expect(bytesAt(p, 0x080d, 14)).toEqual(ORIGINAL);
    p = { ...p, ...switchPatch(p, a.id, true) };
    expect(p.patches[0].off).toBeUndefined();
    expect(bytesAt(p, 0x080d, 3)).toEqual([0xee, 0x20, 0xd0]);
    expect(switchPatch(p, a.id, true).files).toBe(p.files);
    // removed while off: nothing to put back
    p = { ...p, ...switchPatch(p, a.id, false) };
    expect(withoutPatch(p, a.id)).toEqual({ files: p.files, patches: [] });
  });

  it('is kept in the project file, marked in the source and exported as a PRG of its own', () => {
    let p = project();
    const a = ok(plan(p, { name: 'red border', start: 0x080d, end: 0x0815, source: '  lda #$02\n  sta $d020' })).patch;
    p = { ...p, ...withPatch(p, a) };
    const back = deserializeProject(JSON.parse(JSON.stringify(serializeProject(p))));
    expect(back.patches.map(({ id: _, ...x }) => ({ ...x, bytes: [...x.bytes], old: [...x.old] })))
      .toEqual(p.patches.map(({ id: _, ...x }) => ({ ...x, bytes: [...x.bytes], old: [...x.old] })));
    expect(deserializeProject(JSON.parse(JSON.stringify(serializeProject(project())))).patches).toEqual([]);

    const { A, R } = ctx(p);
    expect(verify(A, R).ok).toBe(true);
    const src = R.files['fix.asm'] as string;
    expect(src).toContain('// ==== patch "red border": $080d-$0814, 8 bytes written over the original ====');
    expect(src).toContain('// ==== end of patch "red border" ====');
    expect(src.indexOf('==== patch')).toBeLessThan(src.indexOf('lda #$02'));

    const out = exportFiles(p, R, p.settings);
    expect(Object.keys(out).filter(k => k.startsWith('patches/'))).toEqual(['patches/red_border.asm']);
    const asm = out['patches/red_border.asm'] as string;
    expect(asm).toBe([
      '// Patch "red border" by Mimir Studio: $080d-$0814 of fix.prg, 8 bytes written over the original',
      '// It assembles on its own to a PRG that loads at $080d: java -jar KickAss.jar red_border.asm',
      '',
      '.pc = $080d "red border"',
      '  lda #$02',
      '  sta $d020',
      '  .fill 3, $ea              // the rest of the range: NOP',
      '',
    ].join('\n'));
    expect([...assembleAlone(asm)]).toEqual([...makePrg(0x080d, a.bytes)]);
    expect([...(out['original/fix.prg'] as Uint8Array)]).toEqual([...makePrg(0x0801, fromSource('fix.prg', SRC).bytes)]);
    expect(out['README.md']).toContain('- `patches/red_border.asm` — the patch "red border", $080d-$0814 (8 bytes), as a source of its own: it assembles to a PRG that loads where it goes');
  });

  it('as a source of its own, defines the names its code uses; with a name gone, it has the bytes', () => {
    let p = project();
    const source = 'wait:\n        lda #$02\n        sta VIC_BORDER_COLOR   // red\n        jmp loop';
    const a = ok(plan(p, { name: 'red', start: 0x080d, end: 0x0817, source })).patch;
    p = { ...p, ...withPatch(p, a) };
    let { R } = ctx(p);
    const asm = patchSource(R, p.settings, a, 'fix.prg');
    expect(asm).toContain('// the names the code uses, from the program and the C64 hardware\n.label VIC_BORDER_COLOR = $d020\n.label loop = $0817\n\n.pc = $080d "red"\nwait:\n');
    expect(asm).toContain('        .fill 2, $ea              // the rest of the range: NOP');
    expect([...assembleAlone(asm)]).toEqual([...makePrg(0x080d, a.bytes)]);
    // `loop` renamed: the code would not assemble, so the source has the bytes the patch writes
    p = { ...p, labels: { [0x0817]: 'again' } };
    ({ R } = ctx(p));
    const bytes = patchSource(R, p.settings, a, 'fix.prg');
    expect(bytes).toContain('// The code no longer assembles to these bytes');
    expect(bytes).toContain('//           jmp loop\n');
    expect(bytes).toContain('.pc = $080d "red"\n        .byte $a9, $02, $8d, $20, $d0, $4c, $17, $08\n        .byte $ea, $ea\n');
    expect([...assembleAlone(bytes)]).toEqual([...makePrg(0x080d, a.bytes)]);
  });

  it('names its files safely', () => {
    expect(patchFileName('  fix: irq/nmi  ')).toBe('fix_irq_nmi.prg');
    expect(patchFileName('..')).toBe('patch.prg');
    expect(patchFileName('v1.2-hack', 'asm')).toBe('v1.2-hack.asm');
  });
});
