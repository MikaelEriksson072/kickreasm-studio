import { describe, expect, it } from 'vitest';
import { analyze, demoProject, findBlock, lineText, render } from '@mimir/core';
import { foldLines } from '../src/lib/fold';
import { fileLineNumbers } from '../src/lib/lines';

const p = demoProject();
const A = analyze(p);
const R = render(A, p);

describe('folding the listing', () => {
  it('shows every line when nothing is folded', () => {
    const v = foldLines(R.lines, A.blocks, new Set());
    expect(v.lines).toEqual(R.lines);
    expect([...v.lineNo]).toEqual([...fileLineNumbers(R.lines)]);
    expect(v.hidden.size).toBe(0);
  });

  it('keeps only the header of a folded block, which then stands for all its bytes', () => {
    const sine = findBlock(A.blocks, 0x09b5)!;
    const v = foldLines(R.lines, A.blocks, new Set([sine.start]));
    const h = v.lines.findIndex(l => l.k === 'hdr' && l.a === sine.start);
    expect(v.hidden.get(h)).toBeGreaterThan(10);
    expect(v.lines.length).toBe(R.lines.length - v.hidden.get(h)!);
    for (let a = sine.start; a < sine.end; a++) expect(v.lineOf[a]).toBe(h);
    // the next block starts right after the header and the blank line
    expect(v.lines[h + 1].k).toBe('blank');
    expect(v.lines[h + 2]).toMatchObject({ k: 'hdr', a: sine.end });
    // line numbers stay those of the .asm file
    const file = (R.files['raster-demo.asm'] as string).split('\n');
    v.lines.forEach((l, i) => { if (l.k !== 'file') expect(file[v.lineNo[i] - 1]).toBe(lineText(l, A.S)); });
  });

  it('folds several blocks, and addresses outside them still map to their own lines', () => {
    const starts = A.blocks.filter(b => b.type !== 'code').map(b => b.start);
    const v = foldLines(R.lines, A.blocks, new Set(starts));
    expect(v.hidden.size).toBe(starts.length);
    const code = A.blocks.find(b => b.type === 'code')!;
    const at = v.lineOf[code.start];
    expect(v.lines[at]).toMatchObject({ a: code.start });
    expect(v.lines[at].k).not.toBe('hdr');
  });
});
