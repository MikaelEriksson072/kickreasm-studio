import { describe, expect, it } from 'vitest';
import { demoProject } from '@mimir/core';
import { commit, commitReplace, HISTORY_LIMIT, initHistory, redo, undo } from '../src/store/history';

describe('patch-based undo/redo', () => {
  it('undoes and redoes project edits with patches, keeping file buffers shared', () => {
    const p0 = demoProject();
    let h = initHistory(p0);
    h = commit(h, 'Rename', d => { d.labels[0x0810] = 'main'; });
    h = commit(h, 'Mark as code', d => { d.overrides.push({ start: 0x0a00, end: 0x0a10, type: 'code' }); });
    expect(h.past.map(s => s.label)).toEqual(['Rename', 'Mark as code']);
    expect(h.present.files).toBe(p0.files); // structural sharing: analysis inputs keep their identity
    h = undo(h);
    expect(h.present.overrides).toEqual([]);
    expect(h.present.labels).toEqual({ 2064: 'main' });
    h = undo(h);
    expect(h.present.labels).toEqual({});
    h = redo(redo(h));
    expect(h.present.overrides).toHaveLength(1);
    expect(h.future).toEqual([]);
  });

  it('ignores no-op edits and drops the redo stack on a new edit', () => {
    let h = initHistory(demoProject());
    const same = commit(h, 'nothing', () => { /* no change */ });
    expect(same).toBe(h);
    h = commit(h, 'a', d => { d.name = 'a'; });
    h = undo(h);
    h = commit(h, 'b', d => { d.name = 'b'; });
    expect(h.future).toEqual([]);
    expect(h.present.name).toBe('b');
  });

  it('replaces the whole project as one undoable step', () => {
    const p0 = demoProject();
    let h = commit(initHistory(p0), 'Rename', d => { d.labels[0x0810] = 'main'; });
    const other = { ...demoProject(), name: 'quicksave' };
    h = commitReplace(h, 'Open the VICE quicksave', other);
    expect(h.present).toBe(other);
    expect(h.past.map(s => s.label)).toEqual(['Rename', 'Open the VICE quicksave']);
    h = undo(h);
    expect(h.present.name).toBe(p0.name);
    expect(h.present.labels).toEqual({ 2064: 'main' });
    expect(h.present.files).toBe(p0.files);
    expect(redo(h).present.name).toBe('quicksave');
  });

  it(`keeps at most ${HISTORY_LIMIT} steps`, () => {
    let h = initHistory(demoProject());
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = commit(h, `step ${i}`, d => { d.name = `n${i}`; });
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0].label).toBe('step 20');
  });
});
