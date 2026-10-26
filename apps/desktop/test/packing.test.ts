/* The packed notice: the heuristics' verdict together with what unp64 -i says. */
import { describe, expect, it } from 'vitest';
import type { PackingInfo } from '@kickreasm/core';
import { withIdentified } from '../src/lib/packing';

const h: PackingInfo = { file: 0, verdict: 'maybe', size: 6000, codeBytes: 46, entropy: 6.7, packedShare: 0, decruncher: 0x080d, signature: 'a cruncher', reasons: ['6.70 bits of entropy per byte outside the code'] };
const file = { index: 0, size: 6000, entry: 0x080d };

describe('withIdentified', () => {
  it('keeps the heuristics when unp64 is not the unpacker', () => {
    expect(withIdentified(h, undefined, file, 'unp64')).toBe(h);
    expect(withIdentified(null, { supported: false, known: false, packer: null, tool: 'node' }, file, 'node')).toBeNull();
  });

  it('takes the packer unp64 names, and reports a file the heuristics missed', () => {
    const id = { supported: true, known: true, packer: 'Time Cruncher v3.1', tool: 'unp64.exe' };
    expect(withIdentified(h, id, file, 'unp64')).toMatchObject({ verdict: 'packed', signature: 'Time Cruncher v3.1', reasons: ['unp64 identifies Time Cruncher v3.1', '6.70 bits of entropy per byte outside the code'] });
    expect(withIdentified(null, id, file, 'unp64')).toMatchObject({ verdict: 'packed', signature: 'Time Cruncher v3.1', decruncher: 0x080d, reasons: ['unp64 identifies Time Cruncher v3.1'] });
  });

  it('says when unp64 does not know the packer, and drops weak signs then', () => {
    const unknown = { supported: true, known: false, packer: null, tool: 'unp64.exe' };
    expect(withIdentified({ ...h, verdict: 'packed' }, unknown, file, 'unp64')!.reasons.at(-1)).toBe('unp64 does not know the packer');
    expect(withIdentified(h, unknown, file, 'unp64')).toBeNull(); // only "maybe"
    expect(withIdentified(null, unknown, file, 'unp64')).toBeNull();
  });
});
