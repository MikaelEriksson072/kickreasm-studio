/* The packed notice: the heuristics' verdict together with what the built-in unpacker finds, or what unp64 -i says. */
import { describe, expect, it } from 'vitest';
import type { LayerReport, PackingInfo, UnpackRun } from '@mimir/core';
import { withIdentified, withUnpackRun } from '../src/lib/packing';

const h: PackingInfo = { file: 0, verdict: 'maybe', size: 6000, codeBytes: 46, entropy: 6.7, packedShare: 0, decruncher: 0x080d, signature: 'a cruncher', reasons: ['6.70 bits of entropy per byte outside the code'] };
const file = { index: 0, size: 6000, entry: 0x080d };

/** a run of the built-in unpacker with these layers (the last one the program) */
const run = (layers: [number, LayerReport['kind'], string?][], stop: UnpackRun['stop']['reason'] = 'settled'): UnpackRun => {
  const ls = layers.map(([entry, kind, name], index) => ({ index, entry, kind, fingerprint: `f${index}`.padEnd(8, '0'), packer: name ? { name, similarity: 0.95 } : null }) as LayerReport);
  const unpacked = ls.length > 1, last = ls[ls.length - 1];
  return { unpacked, layers: ls, stop: { reason: stop, pc: 0x1000, detail: '', cycle: 0 }, saved: unpacked ? { layer: last.index, prg: new Uint8Array(3), start: 0x0801, end: 0x2000, entry: last.entry, basic: false, port: 0x37, interrupts: true } : null, basic: [], roms: 'stand-ins (no ROM files)', drive: null, cycles: 0, ms: 1 };
};

describe('withUnpackRun', () => {
  it('keeps the heuristics while the unpacker runs', () => {
    expect(withUnpackRun(h, undefined, file)).toBe(h);
    expect(withUnpackRun(null, undefined, file)).toBeNull();
  });

  it('a file it peels a layer off is packed, and the fingerprints name the packers', () => {
    const exo = run([[0x080d, 'mover', 'Exomizer v3.0'], [0x0100, 'decruncher', 'Exomizer v3.0'], [0x1000, 'program']]);
    expect(withUnpackRun(h, exo, file)).toMatchObject({
      verdict: 'packed', signature: 'Exomizer v3.0',
      reasons: ['the built-in unpacker peels off 2 layers: Exomizer v3.0 (a mover at $080d), then Exomizer v3.0 (a decruncher at $0100); the program starts at $1000', '6.70 bits of entropy per byte outside the code'],
    });
    // one the heuristics missed, behind a coder and a packer the signatures do not know
    const unknown = run([[0x080d, 'decoder', 'XOR coder'], [0x0400, 'jump'], [0x0200, 'decruncher'], [0x0900, 'program']]);
    expect(withUnpackRun(null, unknown, file)).toMatchObject({
      verdict: 'packed', signature: 'XOR coder', decruncher: 0x080d,
      reasons: ['the built-in unpacker peels off 2 layers: XOR coder (a decoder at $080d), then an unknown decruncher at $0200 (fingerprint f2000000); the program starts at $0900'],
    });
    // with no name at all the heuristics' guess from the text stays
    expect(withUnpackRun(h, run([[0x080d, 'mover'], [0x0810, 'program']]), file)).toMatchObject({ verdict: 'packed', signature: 'a cruncher' });
  });

  it('drops weak signs when it ran the program and nothing unpacked itself, and says so for strong ones', () => {
    const none = run([[0x080d, 'program']]);
    expect(withUnpackRun(h, none, file)).toBeNull();
    expect(withUnpackRun(null, none, file)).toBeNull();
    expect(withUnpackRun({ ...h, verdict: 'packed' }, none, file)!.reasons.at(-1)).toBe('the built-in unpacker peels off no layer (it stopped: settled)');
    // a run that ended on a load or a limit proves nothing
    expect(withUnpackRun(h, run([[0x080d, 'program']], 'load'), file)!.reasons.at(-1)).toBe('the built-in unpacker peels off no layer (it stopped: load)');
  });
});

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
