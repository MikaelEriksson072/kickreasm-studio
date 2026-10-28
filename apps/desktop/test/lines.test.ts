import { describe, expect, it } from 'vitest';
import { analyze, demoProject, lineText, makeDemo, parsePrg, render, type ProjectInput } from '@mimir/core';
import { fileLineNumbers } from '../src/lib/lines';

/** every listing line's number must point at exactly that line of its .asm file */
function check(p: ProjectInput) {
  const A = analyze(p);
  const R = render(A, p);
  const nums = fileLineNumbers(R.lines);
  let file: string[] = [];
  let checked = 0;
  R.lines.forEach((l, i) => {
    if (l.k === 'file') { expect(nums[i]).toBe(0); file = (R.files[l.text] as string).split('\n'); return; }
    expect(file[nums[i] - 1], `listing line ${i}`).toBe(lineText(l, A.S));
    checked++;
  });
  return checked;
}

describe('listing line numbers', () => {
  it('match the lines of the .asm file', () => {
    const p = demoProject();
    expect(check({ ...p, notes: { 0x0810: { text: 'two\nlines', block: true } }, blockComments: { 0x0810: 'a\nb' } })).toBeGreaterThan(250);
  });

  it('start again at 1 in every file of a project', () => {
    const d = makeDemo();
    const a = parsePrg('a.prg', d.prg), b = { ...parsePrg('b.prg', d.prg.slice(0, 2002)), load: 0xc000 };
    check({ name: 'two', files: [a, b] });
    const R = render(analyze({ name: 'two', files: [a, b] }), { name: 'two', files: [a, b] });
    const nums = fileLineNumbers(R.lines);
    const second = R.lines.findIndex((l, i) => i > 0 && l.k === 'file');
    expect(second).toBeGreaterThan(0);
    expect(nums[second + 1]).toBe(1);
  });
});
